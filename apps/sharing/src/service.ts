import { createServer, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { uptime } from "node:os";
import { MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import {
  MAX_ACTIVE_SHARES,
  SHARE_LIFETIME_MS,
  type Share,
  type ShareWrite,
} from "@irudd-scope/protocol/sharing";
import { SharingStore } from "./store.ts";

export type Connector = { hostname: string; stop: () => Promise<void> };
export type Connect = (
  port: number,
  signal: AbortSignal,
  disconnected: () => void,
) => Promise<Connector>;
type Clock = { wall: () => number; elapsed: () => number };
type LiveShare = {
  share: Share;
  content: Buffer;
  mediaType: string;
  token: string;
  server: Server;
  abort: AbortController;
  connector?: Connector;
  connecting?: Promise<Connector>;
  deadline: number;
  started: number;
  wall: number;
};
export class SharingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class SharingService {
  private readonly live = new Map<string, LiveShare>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private writing = false;
  private closed = false;
  private storageFailed = false;
  constructor(
    readonly store: SharingStore,
    private readonly connect: Connect,
    private readonly clock: Clock = { wall: Date.now, elapsed: () => uptime() * 1000 },
  ) {
    store.recover();
    this.timer = setInterval(() => this.checkExpiry(), 250);
    this.timer.unref();
  }
  private valid(item: LiveShare) {
    const wall = this.clock.wall();
    const elapsed = this.clock.elapsed();
    const valid =
      Number.isFinite(wall) &&
      Number.isFinite(elapsed) &&
      wall >= item.wall &&
      elapsed >= item.started &&
      wall < item.share.expiresAt &&
      elapsed < item.deadline;
    item.wall = Math.max(item.wall, wall);
    return valid;
  }
  checkExpiry() {
    for (const [id, item] of this.live)
      if (!this.valid(item)) void this.stop(id, "expired").catch(() => {});
  }
  status() {
    this.checkExpiry();
    if (this.storageFailed) throw this.storageError();
    return this.store.status();
  }
  async write(id: string, input: ShareWrite) {
    if (this.closed) throw new SharingError(503, "The sharing service is stopping.");
    if (this.writing)
      throw new SharingError(409, "Another share is being prepared. Retry shortly.");
    this.writing = true;
    try {
      return await this.writeSnapshot(id, input);
    } finally {
      this.writing = false;
    }
  }
  private async writeSnapshot(id: string, input: ShareWrite) {
    if (this.store.stopped(id)) throw new SharingError(409, "This share was stopped.");
    this.checkExpiry();
    const bytes = Buffer.from(input.content, "base64");
    if (bytes.length > MAX_CONTENT_BYTES || bytes.toString("base64") !== input.content)
      throw new SharingError(400, "Invalid snapshot content.");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input.tabId, input.title, input.mediaType]))
      .update(bytes)
      .digest("hex");
    const previous = this.store.record(id);
    if (previous?.operation === input.operationId) {
      if (previous.fingerprint !== fingerprint)
        throw new SharingError(409, "This operation was already used for different content.");
      return previous.share;
    }
    if (previous) {
      const item = this.live.get(id);
      if (!item || previous.share.status !== "active" || !this.valid(item))
        throw new SharingError(409, "This share has ended. Create a fresh share from the tab.");
      if (
        input.expectedRevision !== previous.share.revision ||
        input.tabId !== previous.share.tabId
      )
        throw new SharingError(409, "The shared copy changed. Reopen it before refreshing.");
      const next = this.store.refresh(previous.share, input, bytes, fingerprint, this.clock.wall());
      item.content = bytes;
      item.mediaType = input.mediaType;
      item.share = next;
      return next;
    }
    if (input.expectedRevision !== null)
      throw new SharingError(409, "This share no longer exists.");
    if (this.live.size >= MAX_ACTIVE_SHARES)
      throw new SharingError(
        409,
        "Stop a share before creating another. The service allows five active shares.",
      );
    if ([...this.live.values()].some((item) => item.share.tabId === input.tabId))
      throw new SharingError(
        409,
        "This tab already has a share. Reopen it to refresh the content.",
      );
    const now = this.clock.wall();
    const share = this.store.create(id, input, bytes, fingerprint, now);
    const started = this.clock.elapsed();
    const server = createServer(
      { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 },
      (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Connection", "close");
        const item = this.live.get(id);
        if (!item || !this.valid(item)) {
          res.writeHead(410).end();
          if (item) void this.stop(id, "expired").catch(() => {});
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.setHeader("Allow", "GET, HEAD");
          res.writeHead(405).end();
          return;
        }
        if (
          req.url !== `/${item.token}` ||
          (req.headers["content-length"] && req.headers["content-length"] !== "0") ||
          req.headers["transfer-encoding"]
        ) {
          res.writeHead(404).end();
          return;
        }
        if (item.share.status !== "active") {
          res.writeHead(503).end();
          return;
        }
        res.setHeader(
          "Content-Type",
          item.mediaType === "text/plain" ? "text/plain; charset=utf-8" : item.mediaType,
        );
        res.setHeader("Content-Length", item.content.length);
        res.writeHead(200);
        res.end(req.method === "HEAD" ? undefined : item.content);
      },
    );
    server.maxConnections = 32;
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("connect", (_req, socket) => socket.destroy());
    server.on("checkContinue", (_req, res) => res.writeHead(417, { Connection: "close" }).end());
    const item: LiveShare = {
      share,
      content: bytes,
      mediaType: input.mediaType,
      token: this.store.record(id)!.token,
      server,
      abort: new AbortController(),
      deadline: started + SHARE_LIFETIME_MS,
      started,
      wall: now,
    };
    this.live.set(id, item);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        const canceled = () => reject(new Error("Share stopped."));
        item.abort.signal.addEventListener("abort", canceled, { once: true });
        server.listen({ port: 0, host: "127.0.0.1", signal: item.abort.signal }, () => {
          item.abort.signal.removeEventListener("abort", canceled);
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No content listener.");
      item.connecting = this.connect(address.port, item.abort.signal, () => {
        void this.stop(id, "failed").catch(() => {});
      });
      item.connector = await item.connecting;
      if (this.closed || this.live.get(id) !== item || !this.valid(item))
        throw new Error("Share ended before the tunnel connected.");
      if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(item.connector.hostname))
        throw new Error("Invalid tunnel hostname.");
      item.share = {
        ...share,
        status: "active",
        url: `https://${item.connector.hostname}/${item.token}`,
      };
      this.store.set(item.share);
      return item.share;
    } catch {
      await this.stop(id, "failed");
      await item.connector?.stop();
      throw new SharingError(
        503,
        "The public link could not be created. No share was left active.",
      );
    }
  }
  stop(id: string, status: Share["status"] = "stopped"): Promise<void> {
    const stopping = this.stopping.get(id);
    if (stopping) return stopping;
    const item = this.live.get(id);
    this.live.delete(id);
    item?.abort.abort();
    item?.server.closeAllConnections();
    const closing = Promise.all([
      item && new Promise<void>((resolve) => item.server.close(() => resolve())),
      item?.connecting?.then(
        (connector) => connector.stop(),
        () => {},
      ),
    ]);
    let failure: Error | undefined;
    try {
      this.store.rememberStop(id);
      const share = item?.share ?? this.store.record(id)?.share;
      if (share && ["active", "starting"].includes(share.status))
        this.store.set({ ...share, status });
    } catch {
      failure = this.storageError();
    }
    const task = closing.then(() => {
      if (failure) throw failure;
    });
    this.stopping.set(id, task);
    const completed = () => this.stopping.delete(id);
    void task.then(completed, completed);
    return task;
  }
  private storageError() {
    this.storageFailed = true;
    this.closed = true;
    return new SharingError(
      503,
      "The sharing database failed. Restart the service before sharing again.",
    );
  }
  private async stopAll(status: Share["status"]) {
    const tasks = [...this.live.keys()].map((id) => this.stop(id, status));
    const results = await Promise.allSettled([...tasks, ...this.stopping.values()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  async unpair() {
    // Revoke before awaiting connector cleanup so a concurrent upload cannot start.
    let failure: unknown;
    try {
      this.store.unpair();
    } catch {
      failure = this.storageError();
    }
    try {
      await this.stopAll("stopped");
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.stopAll("interrupted");
  }
}

export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(JSON.stringify(value));
}
