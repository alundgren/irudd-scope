import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  ArtifactId,
  ArtifactWrite,
  PublicationRequest,
  PublicationTabId,
  DEFAULT_PORT,
  LiveEvent,
  MAX_CONTENT_BYTES,
  MAX_METADATA_BYTES,
  ScopeError,
  decode,
} from "@irudd-scope/protocol";
import {
  ShrinkRequest,
  ShrinkReceipt,
  type DatabaseShrink,
} from "@irudd-scope/protocol/maintenance";
import { ArtifactStore } from "./store.ts";

export async function startArtifactServer(options: {
  directory: string;
  token: string;
  port?: number;
  initialize?: (store: ArtifactStore) => Promise<void>;
  shrink?: (timeoutMs: number) => Promise<ShrinkReceipt>;
  maintenanceStatus?: () => DatabaseShrink[];
  deleteArtifact?: (id: string) => Promise<{ id: string; deleted: boolean }>;
}) {
  if (options.token.length < 24 || /[\r\n]/.test(options.token))
    throw new Error("Use a publishing token with at least 24 characters and no newlines.");
  const store = await ArtifactStore.open(options.directory);
  try {
    await options.initialize?.(store);
    await store.reclaim();
  } catch (error) {
    await store.close();
    throw error;
  }
  const streams = new Set<ServerResponse>();
  const pending = new Set<Promise<void>>();
  let uploads = 0;
  const sendEvent = (response: ServerResponse, event: LiveEvent) => {
    if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) response.destroy();
  };
  store.onChanged = (value) => {
    const event = decode(LiveEvent, value);
    for (const stream of streams) sendEvent(stream, event);
  };
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
  };

  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const task = handle(request, response)
        .catch((error: unknown) => {
          if (response.headersSent || response.destroyed) {
            response.destroy();
            return;
          }
          json(response, error instanceof ScopeError ? error.status : 500, {
            error:
              error instanceof ScopeError
                ? error.message
                : "Scope could not complete this request.",
          });
        })
        .finally(() => pending.delete(task));
      pending.add(task);
    },
  );

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }
    const expected = Buffer.from(`Bearer ${options.token}`);
    const received = Buffer.from(request.headers.authorization ?? "");
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      throw new ScopeError(401, "A valid publishing token is required.");
    if (request.headers.origin)
      throw new ScopeError(403, "Browser-origin requests are not supported.");

    if (request.method === "GET" && url.pathname === "/v1/events") {
      if (streams.size >= 8) throw new ScopeError(503, "Too many open event streams.");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      streams.add(response);
      sendEvent(response, { type: "ready" });
      const heartbeat = setInterval(() => {
        if (!response.write(": heartbeat\n\n")) response.destroy();
      }, 15_000);
      response.on("close", () => {
        clearInterval(heartbeat);
        streams.delete(response);
      });
      return;
    }
    if (url.pathname === "/v1/maintenance/shrink" && request.method === "POST" && !url.search) {
      const body = await readJson(request, 1024, "Maintenance request exceeds the size limit.");
      const input = validate(() => decode(ShrinkRequest, body));
      request.setTimeout(input.timeoutMs + 5000);
      const receipt = options.shrink
        ? await options.shrink(input.timeoutMs)
        : { target: "desktop", databases: [await store.maintenance.run(true, input.timeoutMs)] };
      json(response, 200, decode(ShrinkReceipt, receipt));
      return;
    }
    if (url.pathname === "/v1/maintenance/status" && request.method === "GET" && !url.search) {
      json(response, 200, {
        target: "desktop",
        databases: options.maintenanceStatus?.() ?? [store.maintenance.latest()].filter(Boolean),
      });
      return;
    }
    const upload = /^\/v1\/tabs\/([^/]+)\/blobs$/.exec(url.pathname);
    if (request.method === "POST" && upload && !url.search) {
      const tabId = validate(() => decode(PublicationTabId, upload[1]));
      if (Number(request.headers["content-length"]) > MAX_CONTENT_BYTES)
        throw new ScopeError(413, "Artifact exceeds the 32 MiB limit.");
      if (uploads >= 4) throw new ScopeError(503, "Scope is busy uploading artifacts. Try again.");
      uploads++;
      try {
        json(response, 201, { blob: await store.upload(tabId, request) });
      } finally {
        uploads--;
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/artifacts") {
      const after = url.searchParams.get("after");
      if (after) validate(() => decode(ArtifactId, after));
      json(response, 200, await store.list(after ?? ""));
      return;
    }
    const match = /^\/v1\/artifacts\/([^/]+)(\/content|\/tab)?$/.exec(url.pathname);
    if (!match) throw new ScopeError(404, "Endpoint not found.");
    const id = validate(() => decode(ArtifactId, decodeURIComponent(match[1])));
    await handleArtifact(request, response, url, id, match[2]);
  }

  async function handleArtifact(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    id: string,
    suffix: string | undefined,
  ) {
    if (request.method === "POST" && suffix === "/tab" && !url.search) {
      const body = await readJson(request, 1024, "Tab request exceeds the size limit.");
      const input = validate(() => decode(PublicationRequest, body));
      json(response, 201, { tabId: await store.reserve(id, input.expectedRevision) });
      return;
    }
    if (request.method === "DELETE" && !suffix && !url.search) {
      const receipt = options.deleteArtifact
        ? await options.deleteArtifact(id)
        : { id, deleted: await store.removeArtifact(id) };
      json(response, 200, receipt);
      return;
    }
    if (request.method === "GET" && suffix !== "/tab") {
      const artifact = await store.get(id);
      if (!suffix) {
        json(response, 200, artifact);
        return;
      }
      const revision = url.searchParams.get("revision");
      if (revision && Number(revision) !== artifact.revision)
        throw new ScopeError(409, "Artifact changed. Reload it to read the current content.");
      const bytes = await store.content(artifact.blob);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": artifact.size,
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      response.end(bytes);
      return;
    }
    if (request.method === "PUT" && !suffix) {
      const body = await readJson(request, MAX_METADATA_BYTES, "Artifact metadata exceeds 16 KiB.");
      const input = validate(() => decode(ArtifactWrite, body));
      const artifact = await store.put(id, input);
      json(response, input.expectedRevision === 0 ? 201 : 200, artifact);
      return;
    }
    throw new ScopeError(405, "Method not supported.");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async (error: unknown) => {
    await store.close();
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scope has no TCP address.");
  store.maintenance.start();
  let closing: Promise<void> | undefined;
  return {
    store,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      (closing ??= (async () => {
        for (const stream of streams) stream.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await store.maintenance.close();
        await Promise.allSettled(pending);
        await store.close();
      })()),
  };
}

function validate<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new ScopeError(400, "Invalid artifact metadata or ID.");
  }
}

async function readJson(
  request: IncomingMessage,
  limit: number,
  tooLarge: string,
): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw new ScopeError(413, tooLarge);
    parts.push(part);
  }
  return validate(() => JSON.parse(Buffer.concat(parts).toString("utf8")));
}
