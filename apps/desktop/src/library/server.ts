import { DiagramAgentCommand, DiagramAgentReply } from "@irudd-scope/protocol/diagram-agent";
import {
  DiagramCommand,
  DiagramReply,
  MAX_DIAGRAM_REQUEST_BYTES,
} from "@irudd-scope/protocol/diagram";
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
  diagramAgent?: (command: DiagramAgentCommand, signal: AbortSignal) => Promise<DiagramAgentReply>;
  diagram?: (command: DiagramCommand, signal: AbortSignal) => Promise<DiagramReply>;
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
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /health") {
      json(response, 200, { status: "ok" });
      return;
    }
    authenticate(request, options.token);

    if (route === "POST /v1/diagram-agents" && !url.search) {
      await handleDiagramAgent(request, response);
      return;
    }
    if (route === "POST /v1/diagrams" && !url.search) {
      await handleDiagram(request, response);
      return;
    }
    if (route === "GET /v1/events") {
      openEventStream(response);
      return;
    }
    if (route === "POST /v1/maintenance/shrink" && !url.search) {
      await shrink(request, response);
      return;
    }
    if (route === "GET /v1/maintenance/status" && !url.search) {
      json(response, 200, {
        target: "desktop",
        databases: options.maintenanceStatus?.() ?? [store.maintenance.latest()].filter(Boolean),
      });
      return;
    }
    const upload = /^\/v1\/tabs\/([^/]+)\/blobs$/.exec(url.pathname);
    if (request.method === "POST" && upload && !url.search) {
      const tabId = validate(() => decode(PublicationTabId, upload[1]));
      await uploadContent(request, response, tabId);
      return;
    }
    if (route === "GET /v1/artifacts") {
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

  async function handleDiagramAgent(request: IncomingMessage, response: ServerResponse) {
    if (!options.diagramAgent) throw new ScopeError(503, "The diagram editor is unavailable.");
    const body = await readJson(
      request,
      MAX_DIAGRAM_REQUEST_BYTES,
      "Diagram request exceeds 512 KiB.",
    );
    const command = validate(() => decode(DiagramAgentCommand, body));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      json(
        response,
        200,
        decode(DiagramAgentReply, await options.diagramAgent(command, controller.signal)),
      );
    } finally {
      response.off("close", cancel);
    }
  }

  async function handleDiagram(request: IncomingMessage, response: ServerResponse) {
    if (!options.diagram) throw new ScopeError(503, "The diagram editor is unavailable.");
    const body = await readJson(
      request,
      MAX_DIAGRAM_REQUEST_BYTES,
      "Diagram request exceeds 512 KiB.",
    );
    const command = validate(() => decode(DiagramCommand, body));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      json(response, 200, decode(DiagramReply, await options.diagram(command, controller.signal)));
    } finally {
      response.off("close", cancel);
    }
  }

  function openEventStream(response: ServerResponse) {
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
  }

  async function shrink(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request, 1024, "Maintenance request exceeds the size limit.");
    const input = validate(() => decode(ShrinkRequest, body));
    request.setTimeout(input.timeoutMs + 5000);
    const receipt = options.shrink
      ? await options.shrink(input.timeoutMs)
      : { target: "desktop", databases: [await store.maintenance.run(true, input.timeoutMs)] };
    json(response, 200, decode(ShrinkReceipt, receipt));
  }

  async function uploadContent(request: IncomingMessage, response: ServerResponse, tabId: string) {
    if (Number(request.headers["content-length"]) > MAX_CONTENT_BYTES)
      throw new ScopeError(413, "Artifact exceeds the 32 MiB limit.");
    if (uploads >= 4) throw new ScopeError(503, "Scope is busy uploading artifacts. Try again.");
    uploads++;
    try {
      json(response, 201, { blob: await store.upload(tabId, request) });
    } finally {
      uploads--;
    }
  }

  async function serveContent(response: ServerResponse, url: URL, id: string) {
    const artifact = await store.get(id);
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
  }

  async function handleArtifact(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    id: string,
    suffix: string | undefined,
  ) {
    switch (request.method) {
      case "POST": {
        if (suffix !== "/tab" || url.search) break;
        const body = await readJson(request, 1024, "Tab request exceeds the size limit.");
        const input = validate(() => decode(PublicationRequest, body));
        json(response, 201, { tabId: await store.reserve(id, input.expectedRevision) });
        return;
      }
      case "DELETE": {
        if (suffix || url.search) break;
        const receipt = options.deleteArtifact
          ? await options.deleteArtifact(id)
          : { id, deleted: await store.removeArtifact(id) };
        json(response, 200, receipt);
        return;
      }
      case "GET":
        if (suffix === "/tab") break;
        if (suffix) await serveContent(response, url, id);
        else json(response, 200, await store.get(id));
        return;
      case "PUT": {
        if (suffix) break;
        const body = await readJson(
          request,
          MAX_METADATA_BYTES,
          "Artifact metadata exceeds 16 KiB.",
        );
        const input = validate(() => decode(ArtifactWrite, body));
        const artifact = await store.put(id, input);
        json(response, input.expectedRevision === 0 ? 201 : 200, artifact);
        return;
      }
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

function authenticate(request: IncomingMessage, token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(request.headers.authorization ?? "");
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new ScopeError(401, "A valid publishing token is required.");
  if (request.headers.origin)
    throw new ScopeError(403, "Browser-origin requests are not supported.");
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
