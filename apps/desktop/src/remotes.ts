import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";
import { decode, validateEndpoint } from "@irudd-scope/protocol";
import {
  artifactRequest,
  PairReceipt,
  readPairingUrl,
  readRemoteJson,
  readRelayEvents,
  type RelayRequest,
  RELAY_CAPABILITIES_HEADER,
  RELAY_WAKE_HEADER,
} from "@irudd-scope/protocol/remote";
import {
  FOLDER_CAPABILITY,
  MAX_FOLDER_WATCHES,
  folderCommandRequest,
} from "@irudd-scope/protocol/folder";
import type { DesktopStore } from "./desktop-store.ts";
import { RELAY_ORIGIN_HEADER, type Remote, type RemoteStatus } from "./remote-contract.ts";
import { synchronizeRemote } from "./remote-updates.ts";

type Connection = { controller: AbortController; task: Promise<void> };
/** An authenticated request to a connected hub's relay API, valid until the session ends. */
export type RemoteCall = (
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
) => Promise<Response>;
type SessionListener = (remote: Remote, call: RemoteCall, signal: AbortSignal) => void;
type Session = { endpoint: string; token: string; signal: AbortSignal; active: number };
/** Options for a streamed relay request. Deadlines are per operation, not global. */
export type RemoteRequest = {
  method?: "GET" | "POST" | "PUT";
  body?: BodyInit;
  contentType?: string;
  signal?: AbortSignal;
  /** Total time allowed for the request, including the response body. */
  deadlineMs: number;
  /** The request fails when the response body is silent this long. */
  idleMs?: number;
};
/** The remote has no live relay session, so its files cannot be reached. */
export class RemoteUnavailableError extends Error {
  constructor(message = "The remote is offline.") {
    super(message);
    this.name = "RemoteUnavailableError";
  }
}
const MAX_STREAMED_REQUESTS = 32;

export class Remotes {
  private readonly statuses = new Map<string, RemoteStatus>();
  private readonly connections = new Map<string, Connection>();
  private readonly updating = new Map<string, Connection>();
  private readonly pairing = new AbortController();
  private readonly sessionListeners = new Set<SessionListener>();
  private readonly sessions = new Map<string, Session>();
  private pending = Promise.resolve();
  private closed = false;

  constructor(
    private readonly store: DesktopStore,
    private readonly local: { url: string; token: string; originSecret?: string },
    private readonly onChange: (status: RemoteStatus[]) => void,
    private readonly currentCommit?: string,
  ) {}

  snapshot() {
    return [...this.statuses.values()];
  }
  /**
   * Opens a request on a connected remote's relay API with a raw streamed body. It is
   * cancelled by the caller, by its deadline, by a silent response, or when the session ends.
   */
  async request(remoteId: string, path: string, options: RemoteRequest): Promise<Response> {
    const session = this.sessions.get(remoteId);
    if (!session || session.signal.aborted) throw new RemoteUnavailableError();
    if (session.active >= MAX_STREAMED_REQUESTS)
      throw new Error("Too many folder requests to this remote. Retry shortly.");
    const controller = new AbortController();
    const signal = AbortSignal.any([
      session.signal,
      controller.signal,
      AbortSignal.timeout(options.deadlineMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    session.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      session.active--;
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${session.token}`,
          ...(options.contentType ? { "Content-Type": options.contentType } : {}),
        },
        body: options.body,
        duplex: "half",
        redirect: "error",
        signal,
      };
      const response = await fetch(`${session.endpoint}${path}`, init).catch((error: unknown) => {
        if (session.signal.aborted) throw new RemoteUnavailableError();
        throw error;
      });
      if (!response.body) {
        release();
        return response;
      }
      return new Response(watchIdle(response.body, controller, options.idleMs, release), {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      release();
      controller.abort();
      throw error;
    }
  }
  onSession(listener: SessionListener) {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }
  private status(remote: Remote, connection: RemoteStatus["connection"], message: string) {
    this.statuses.set(remote.id, {
      ...remote,
      connection,
      message,
      update: this.statuses.get(remote.id)?.update,
    });
    this.onChange(this.snapshot());
  }
  async start() {
    for (const remote of await this.store.remotes()) {
      this.status(remote, "disconnected", "Disconnected.");
      if (remote.enabled) this.connect(remote);
    }
  }
  private change(action: () => Promise<void>) {
    if (this.closed) return Promise.reject(new Error("Scope is closing."));
    const task = this.pending.then(action);
    this.pending = task.catch(() => {});
    return task;
  }
  pair(value: string) {
    return this.change(() => this.performPair(value));
  }
  private async performPair(value: string) {
    const { endpoint, token } = readPairingUrl(value);
    const response = await fetch(`${endpoint}/v1/pair`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: hostname().slice(0, 160) }),
      signal: AbortSignal.any([this.pairing.signal, AbortSignal.timeout(10_000)]),
    }).catch(() => {
      throw new Error(
        "Could not reach the hub. Check that both machines are on the tailnet and the hub is running.",
      );
    });
    if (!response.ok)
      throw new Error("Pairing failed. Run irudd-scope pair on the remote for a fresh link.");
    const receipt = await readRemoteJson(response)
      .then((value) => decode(PairReceipt, value))
      .catch(() => {
        throw new Error(
          "The hub returned an invalid pairing receipt. Generate a new pairing on the remote and retry.",
        );
      });
    if (this.statuses.has(receipt.id)) await this.disconnect(receipt.id);
    const remote: Remote = { id: receipt.id, name: receipt.name, endpoint, enabled: true };
    try {
      await this.store.saveRemote(remote, receipt.token);
    } catch {
      await fetch(`${endpoint}/v1/relay/disconnect`, {
        method: "DELETE",
        redirect: "error",
        headers: { Authorization: `Bearer ${receipt.token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      throw new Error(
        "Could not save the pairing credential. Check Keychain access, then generate a new pairing link on the remote.",
      );
    }
    this.connect(remote);
  }
  setEnabled(id: string, enabled: boolean) {
    return this.change(() => this.changeEnabled(id, enabled));
  }
  resume() {
    return this.change(async () => {
      for (const remote of this.statuses.values()) {
        if (!remote.enabled) continue;
        await this.disconnect(remote.id);
        this.connect(remote, true);
      }
    });
  }
  private async changeEnabled(id: string, enabled: boolean) {
    const previous = this.statuses.get(id);
    if (!previous) throw new Error("Remote not found.");
    const remote: Remote = {
      id: previous.id,
      name: previous.name,
      endpoint: previous.endpoint,
      enabled,
    };
    await this.store.saveRemote(remote);
    await this.disconnect(id);
    this.status(remote, "disconnected", "Disconnected.");
    if (enabled) this.connect(remote);
  }
  remove(id: string) {
    return this.change(() => this.removeSaved(id));
  }
  private async removeSaved(id: string) {
    const remote = this.statuses.get(id);
    if (!remote) return;
    await this.changeEnabled(id, false);
    const token = await this.store.remoteToken(id);
    if (token) {
      const response = await fetch(`${validateEndpoint(remote.endpoint)}/v1/relay/disconnect`, {
        method: "DELETE",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      if (!response || (!response.ok && response.status !== 401))
        throw new Error(
          "The hub is unreachable. This remote is disconnected. Start the hub and retry removal so its credential can be revoked.",
        );
    }
    await this.store.removeRemote(id);
    this.statuses.delete(id);
    this.onChange(this.snapshot());
  }
  private async disconnect(id: string) {
    const connection = this.connections.get(id);
    connection?.controller.abort();
    const update = this.updating.get(id);
    update?.controller.abort();
    await update?.task;
    if (!connection) return;
    await connection.task;
    this.connections.delete(id);
  }
  async retryUpdate(id: string) {
    const remote = this.statuses.get(id);
    const connection = this.connections.get(id);
    if (!this.currentCommit || !remote?.enabled || remote.connection !== "connected" || !connection)
      throw new Error("Connect the remote from the installed desktop app before retrying.");
    const token = await this.store.remoteToken(id);
    if (!token) throw new Error("Pair this remote again. Its credential is unavailable.");
    this.updateRemote(remote, token, connection.controller.signal, true);
  }
  private updateRemote(remote: Remote, token: string, signal: AbortSignal, retry = false) {
    if (!this.currentCommit || this.updating.has(remote.id)) return;
    const controller = new AbortController();
    const task = synchronizeRemote(
      remote.endpoint,
      token,
      this.currentCommit,
      AbortSignal.any([signal, controller.signal]),
      (update) => {
        const current = this.statuses.get(remote.id);
        if (!current || this.closed) return;
        this.statuses.set(remote.id, { ...current, update });
        this.onChange(this.snapshot());
      },
      retry,
    ).finally(() => this.updating.delete(remote.id));
    this.updating.set(remote.id, { controller, task });
  }
  private connect(remote: Remote, waking = false) {
    if (this.closed) return;
    const controller = new AbortController();
    const task = this.run(remote, controller.signal, waking);
    this.connections.set(remote.id, { controller, task });
  }
  private async run(remote: Remote, signal: AbortSignal, waking: boolean) {
    while (!signal.aborted) {
      this.status(remote, "connecting", "Connecting…");
      const session = new AbortController();
      const sessionSignal = AbortSignal.any([signal, session.signal]);
      const requests = new Map<string, AbortController>();
      // Folder watches have their own count so they never take a publication slot.
      const watches = new Map<string, AbortController>();
      const tasks = new Set<Promise<void>>();
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      let checkedUpdates = false;
      const alive = () => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => session.abort(), 30_000);
      };
      try {
        const token = await this.store.remoteToken(remote.id);
        if (!token)
          throw new Error("Pair this remote again. Its credential is unavailable in this session.");
        const endpoint = validateEndpoint(remote.endpoint);
        alive();
        const response = await fetch(`${endpoint}/v1/relay/events`, {
          headers: {
            Authorization: `Bearer ${token}`,
            [RELAY_CAPABILITIES_HEADER]: FOLDER_CAPABILITY,
            ...(waking ? { [RELAY_WAKE_HEADER]: "1" } : {}),
          },
          redirect: "error",
          signal: sessionSignal,
        });
        await readRelayEvents(response, (event) => {
          alive();
          if (event.type === "ready") {
            waking = false;
            this.status(remote, "connected", "Connected. Publications arrive while Scope is open.");
            if (!checkedUpdates) {
              checkedUpdates = true;
              this.sessions.set(remote.id, { endpoint, token, signal: sessionSignal, active: 0 });
              this.updateRemote(remote, token, sessionSignal);
              const call: RemoteCall = (method, path, body) =>
                fetch(`${endpoint}${path}`, {
                  method,
                  headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                  },
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                  redirect: "error",
                  signal: AbortSignal.any([
                    sessionSignal,
                    AbortSignal.timeout(path === "/v1/relay/memory/sync" ? 300_000 : 15_000),
                  ]),
                });
              for (const listener of this.sessionListeners) listener(remote, call, sessionSignal);
            }
            return;
          }
          if (event.type === "cancel") {
            (requests.get(event.id) ?? watches.get(event.id))?.abort();
            return;
          }
          const watch = event.method === "GET" && folderCommandRequest(event.method, event.path);
          if (
            !(
              artifactRequest(event.method, event.path) ||
              folderCommandRequest(event.method, event.path)
            ) ||
            requests.has(event.id) ||
            watches.has(event.id) ||
            (!watch && requests.size >= 16)
          )
            throw new Error("The hub sent an invalid publication request.");
          // A watch the hub already ended can still be stopping here. An extra watch waits
          // for the hub's deadline instead of dropping the relay.
          if (watch && watches.size >= MAX_FOLDER_WATCHES * 2) return;
          const slots = watch ? watches : requests;
          const controller = new AbortController();
          slots.set(event.id, controller);
          const task = this.forward(
            endpoint,
            token,
            folderCommandRequest(event.method, event.path) && this.local.originSecret
              ? { ...event, origin: `${this.local.originSecret}:${remote.id}` }
              : event,
            AbortSignal.any([sessionSignal, controller.signal]),
          ).finally(() => {
            slots.delete(event.id);
            tasks.delete(task);
          });
          tasks.add(task);
        });
      } catch (error) {
        if (!signal.aborted)
          this.status(
            remote,
            "error",
            error instanceof Error && error.message.includes("credential")
              ? error.message
              : "Connection lost. Retrying… Check the hub and tailnet if this continues.",
          );
      } finally {
        clearTimeout(heartbeat);
        session.abort();
        if (this.sessions.get(remote.id)?.signal === sessionSignal) this.sessions.delete(remote.id);
        const update = this.updating.get(remote.id);
        update?.controller.abort();
        await update?.task;
        await Promise.allSettled(tasks);
      }
      await delay(3000, undefined, { signal }).catch(() => {});
    }
  }
  private async forward(
    endpoint: string,
    token: string,
    event: RelayRequest & { origin?: string },
    signal: AbortSignal,
  ) {
    const transfer = new AbortController();
    signal = AbortSignal.any([signal, transfer.signal]);
    const started = performance.now();
    let phase = "received";
    let phaseStarted = started;
    let bodyStarted = started;
    let bodyBytes = 0;
    let bodyComplete = event.method === "GET";
    const describe = (error: unknown, depth = 0): unknown => {
      if (depth > 3) return "Cause depth exceeded.";
      const clean = (value: string) =>
        value.replaceAll(token, "[redacted]").replaceAll(this.local.token, "[redacted]");
      if (!(error instanceof Error)) return clean(String(error));
      return {
        name: error.name,
        message: clean(error.message),
        ...(error.cause === undefined ? {} : { cause: describe(error.cause, depth + 1) }),
        ...("code" in error ? { code: clean(String(error.code)) } : {}),
      };
    };
    const report = (stage: string, details: Record<string, unknown> = {}, failure = false) => {
      if (!failure && process.env.SCOPE_RELAY_TRACE !== "1") return;
      console.error(
        "Scope relay",
        JSON.stringify({
          time: new Date().toISOString(),
          requestId: event.id,
          method: event.method,
          path: event.path,
          stage,
          phase,
          elapsedMs: performance.now() - started,
          phaseMs: performance.now() - phaseStarted,
          bodyBytes,
          bodyComplete,
          aborted: signal.aborted,
          ...details,
        }),
      );
    };
    const canceled = () => report("canceled", { reason: describe(signal.reason) });
    signal.addEventListener("abort", canceled, { once: true });
    report("received");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const base = `${endpoint}/v1/relay/requests/${event.id}`;
      let body: ReadableStream<Uint8Array> | null | undefined;
      if (event.method !== "GET") {
        phase = "body-fetch";
        bodyStarted = performance.now();
        phaseStarted = bodyStarted;
        report("body-started");
        const input = await fetch(`${base}/body`, { headers, redirect: "error", signal });
        report("body-headers", { status: input.status });
        if (!input.ok) throw new Error(`Body retrieval returned HTTP ${input.status}.`);
        const reader = input.body?.getReader();
        let bodyCanceled = false;
        body = reader
          ? new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (bodyCanceled) return;
                  if (next.done) {
                    bodyComplete = true;
                    report("body-ended", { bodyMs: performance.now() - bodyStarted });
                    reader.releaseLock();
                    controller.close();
                  } else {
                    bodyBytes += next.value.byteLength;
                    controller.enqueue(next.value);
                  }
                } catch (error) {
                  if (bodyCanceled) return;
                  report("body-error", { error: describe(error) }, true);
                  reader.releaseLock();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                bodyCanceled = true;
                report("body-canceled");
                try {
                  // Fetch can reject both the transfer and its source reader during cancellation.
                  await reader.cancel(reason).catch(() => {});
                } finally {
                  reader.releaseLock();
                }
              },
            })
          : null;
        if (!reader) bodyComplete = true;
      }
      const init: RequestInit & { duplex: "half" } = {
        method: event.method,
        signal,
        redirect: "error",
        body,
        duplex: "half",
        headers: {
          Authorization: `Bearer ${this.local.token}`,
          ...(event.contentType ? { "Content-Type": event.contentType } : {}),
          ...(event.origin ? { [RELAY_ORIGIN_HEADER]: event.origin } : {}),
        },
      };
      phase = "local-http";
      const localStarted = performance.now();
      phaseStarted = localStarted;
      report("local-started");
      const result = await fetch(`${this.local.url}${event.path}`, init);
      report("local-response", {
        status: result.status,
        localMs: performance.now() - localStarted,
      });
      const responseHeaders = new Headers(headers);
      responseHeaders.set("scope-response-status", String(result.status));
      for (const name of ["content-type", "content-disposition", "content-security-policy"]) {
        const value = result.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      phase = "response-post";
      const postStarted = performance.now();
      phaseStarted = postStarted;
      report("response-started");
      const delivered = await postResponse(`${base}/response`, responseHeaders, result.body, {
        signal,
        streaming: event.method === "GET" && folderCommandRequest(event.method, event.path),
      });
      report("response-headers", { status: delivered.status });
      if (!delivered.ok) throw new Error(`Response delivery returned HTTP ${delivered.status}.`);
      await readRemoteJson(delivered);
      report("response-delivered", { postMs: performance.now() - postStarted });
    } catch (error) {
      report("forward-error", { error: describe(error) }, true);
    } finally {
      signal.removeEventListener("abort", canceled);
      transfer.abort();
    }
  }
  async close() {
    this.closed = true;
    this.pairing.abort();
    await this.pending;
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}

/**
 * Posts a relay response to the hub. A `streaming` response, such as a folder watch, can
 * last for hours and uses node:http: fetch keeps a 300-second response-headers deadline
 * while the request body is still being sent, and the hub answers only after the body ends.
 */
function postResponse(
  url: string,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  { signal, streaming }: { signal: AbortSignal; streaming: boolean },
): Promise<Response> {
  if (!streaming) {
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body,
      duplex: "half",
      signal,
      redirect: "error",
    };
    return fetch(url, init);
  }
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      // A pooled socket can be closed by the hub as idle just as it is reused.
      { method: "POST", headers: Object.fromEntries(headers), signal, agent: false },
      (incoming) =>
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: incoming.statusCode,
          }),
        ),
    );
    outgoing.on("error", reject);
    // Node sends headers with the first body bytes, which can be a heartbeat 10 seconds away.
    outgoing.flushHeaders();
    if (body) pipeline(Readable.fromWeb(body as NodeReadableStream), outgoing).catch(reject);
    else outgoing.end();
  });
}

function watchIdle(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleMs: number | undefined,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    clearTimeout(timer);
    if (idleMs)
      timer = setTimeout(
        () => controller.abort(new Error("The remote stopped responding.")),
        idleMs,
      );
  };
  reset();
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await reader.read();
        reset();
        if (next.done) {
          clearTimeout(timer);
          release();
          stream.close();
        } else stream.enqueue(next.value);
      } catch (error) {
        clearTimeout(timer);
        release();
        stream.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(timer);
      release();
      controller.abort();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
