import { MAX_PULL_REQUESTS_REQUEST_BYTES } from "@irudd-scope/protocol/pull-requests";
import { MAX_VOICE_REQUEST_BYTES } from "@irudd-scope/protocol/voice";
import { MAX_PLAN_REQUEST_BYTES } from "@irudd-scope/protocol/plan";
import { MAX_DIAGRAM_REQUEST_BYTES } from "@irudd-scope/protocol/diagram";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  decode,
  MAX_CONTENT_BYTES,
  MAX_METADATA_BYTES,
  ScopeError,
  ArtifactId,
  UPDATE_BASE_HEADER,
} from "@irudd-scope/protocol";
import {
  ShrinkRequest,
  ShrinkReceipt,
  MAX_MAINTENANCE_TIMEOUT_MS,
} from "@irudd-scope/protocol/maintenance";
import {
  artifactRequest,
  maintenanceRequest,
  PairRequest,
  HubUpdateRequest,
  type RelayEvent,
} from "@irudd-scope/protocol/remote";
import type { HubState } from "./state.ts";
import type { HubUpdates } from "./updates.ts";
import { BufferedPublication, readBody } from "./buffered-publication.ts";
import { PublicationDelivery, type RelayCall } from "./publication-delivery.ts";
import { artifactMetadataRequest } from "./artifact-metadata.ts";

type Pending = {
  method: string;
  path: string;
  request: IncomingMessage | Buffer;
  response: ServerResponse | ((error: unknown, value?: unknown) => void);
  bodyRead: boolean;
  answered: boolean;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

function json(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function bounded(limit: number) {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > limit ? new Error("Request exceeds the size limit.") : null, chunk);
    },
  });
}

async function handleUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  updates?: HubUpdates,
) {
  if (!updates) {
    json(response, 200, {
      supported: false,
      phase: "idle",
      message: "This hub uses an unmanaged installation. Update it on the remote.",
    });
    return;
  }
  if (request.method === "GET") {
    json(response, 200, await updates.snapshot());
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024) throw new Error("Update request too large.");
    chunks.push(chunk);
  }
  const input = decode(HubUpdateRequest, JSON.parse(Buffer.concat(chunks).toString()));
  json(response, 202, await updates.request(input));
}

export async function startPairedHub(
  state: HubState,
  port = state.configuration().port,
  updates?: HubUpdates,
) {
  let desktop: ServerResponse | undefined;
  const pending = new Map<string, Pending>();
  function forget(id: string) {
    const item = pending.get(id);
    pending.delete(id);
    if (item) clearTimeout(item.timer);
    return item;
  }
  function send(event: RelayEvent) {
    if (desktop && !desktop.write(`${JSON.stringify(event)}\n`)) desktop.destroy();
  }
  function finish(id: string, error?: string) {
    const item = forget(id);
    if (!item) return;
    if (typeof item.response === "function")
      item.response(new ScopeError(503, error ?? "Buffered delivery interrupted."));
    else if (error) json(item.response, 503, { error });
    item.controller.abort();
    send({ type: "cancel", id });
  }
  function disconnect() {
    const previous = desktop;
    desktop = undefined;
    previous?.destroy();
    for (const id of pending.keys())
      finish(
        id,
        "Scope on the Mac disconnected. Check the artifact before retrying an uncertain write.",
      );
  }
  function requestTimedOut(id: string, receivingDesktop: ServerResponse, error: string) {
    const item = pending.get(id);
    if (!item) return;
    const unstartedWrite = item.method !== "GET" && !item.bodyRead;
    finish(id, error);
    if (unstartedWrite && desktop === receivingDesktop) disconnect();
  }
  const relay: RelayCall = (method, path, body, signal) =>
    new Promise((resolve, reject) => {
      if (!desktop || pending.size >= 16 || signal.aborted) {
        reject(new ScopeError(503, "The desktop relay is unavailable or busy."));
        return;
      }
      const id = randomUUID();
      const receivingDesktop = desktop;
      const abort = () => finish(id);
      const item: Pending = {
        method,
        path,
        request: body,
        response: (error, value) => {
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(value);
        },
        bodyRead: false,
        answered: false,
        controller: new AbortController(),
        timer: setTimeout(
          () => requestTimedOut(id, receivingDesktop, "The Mac did not respond in time."),
          30_000,
        ),
      };
      pending.set(id, item);
      signal.addEventListener("abort", abort, { once: true });
      send({
        type: "request",
        id,
        method,
        path,
        contentType: path.endsWith("/blobs") ? "application/octet-stream" : "application/json",
      });
    });
  const delivery = new PublicationDelivery(state.queue, relay, () => Boolean(desktop));
  const buffered = new BufferedPublication(state.queue, json);
  const queueTimer = setInterval(() => {
    try {
      state.queue.expire();
      state.artifacts.expire();
      delivery.start();
    } catch {
      /* A busy database is retried on the next check. */
    }
  }, 3000);
  queueTimer.unref();
  const server = createServer(
    { requestTimeout: 0, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        json(response, error instanceof ScopeError ? error.status : 400, {
          error:
            error instanceof ScopeError ? error.message : "The hub could not complete the request.",
        });
      });
    },
  );
  server.setTimeout(30_000);
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.origin) {
      json(response, 403, { error: "Browser-origin requests are not supported." });
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/pair" && request.method === "POST")
      return handlePair(request, response, token);
    if (url.pathname.startsWith("/v1/hub/")) return handleHub(request, response, url, token);
    if (url.pathname.startsWith("/v1/relay/")) return handleRelay(request, response, url, token);
    await forwardArtifact(request, response, token);
  }

  async function handlePair(request: IncomingMessage, response: ServerResponse, token: string) {
    if (!state.authenticate(token, "pair")) {
      json(response, 401, {
        error: "Pairing link expired or already used. Run irudd-scope pair again.",
      });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024) throw new Error("Pairing request too large.");
      chunks.push(chunk);
    }
    const input = decode(PairRequest, JSON.parse(Buffer.concat(chunks).toString()));
    try {
      json(response, 200, state.pair(token, input.name));
    } catch {
      json(response, 401, {
        error: "Pairing link expired or already used. Run irudd-scope pair again.",
      });
    }
    return;
  }

  async function handleHub(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    token: string,
  ) {
    if (!state.authenticate(token, "local")) {
      json(response, 401, { error: "Local hub credentials are required." });
      return;
    }
    if (url.pathname === "/v1/hub/maintenance" && request.method === "GET" && !url.search) {
      json(response, 200, {
        target: "hub",
        databases: [state.maintenance.latest()].filter(Boolean),
      });
      return;
    }
    if (url.pathname === "/v1/hub/shrink" && request.method === "POST" && !url.search) {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024) throw new Error("Maintenance request too large.");
        parts.push(chunk);
      }
      const input = decode(ShrinkRequest, JSON.parse(Buffer.concat(parts).toString()));
      request.setTimeout(input.timeoutMs + 5000);
      json(
        response,
        200,
        decode(ShrinkReceipt, {
          target: "hub",
          databases: [await state.maintenance.run(true, input.timeoutMs)],
        }),
      );
      return;
    }
    if (url.pathname === "/v1/hub/status" && request.method === "GET") {
      json(response, 200, {
        ...state.status(),
        connected: Boolean(desktop),
        commit: updates?.installation?.commit,
      });
      return;
    }
    if (url.pathname === "/v1/hub/queue" && request.method === "GET" && !url.search) {
      json(response, 200, state.queue.snapshot());
      return;
    }
    const queued = /^\/v1\/hub\/queue\/([^/]+)$/.exec(url.pathname);
    if (queued && request.method === "DELETE" && !url.search) {
      const id = decode(ArtifactId, queued[1]);
      delivery.cancel(id);
      json(response, 200, { id, deleted: state.queue.remove(id) });
      return;
    }
    if (url.pathname === "/v1/hub/pair" && request.method === "POST") {
      try {
        json(response, 200, { url: state.pairUrl(), expiresInMinutes: 10 });
      } catch (error) {
        json(response, 409, { error: (error as Error).message });
      }
      return;
    }
    if (url.pathname === "/v1/hub/unpair" && request.method === "POST") {
      delivery.cancel();
      state.unpair();
      disconnect();
      json(response, 200, { unpaired: true });
      return;
    }
    json(response, 404, { error: "Endpoint not found." });
    return;
  }

  async function handleRelay(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    token: string,
  ) {
    if (!state.authenticate(token, "desktop")) {
      json(response, 401, { error: "Pair this Mac with the hub again." });
      return;
    }
    if (
      url.pathname === "/v1/relay/update" &&
      !url.search &&
      ["GET", "POST"].includes(request.method ?? "")
    )
      return handleUpdate(request, response, updates);
    if (url.pathname === "/v1/relay/disconnect" && request.method === "DELETE") {
      delivery.cancel();
      state.unpair();
      disconnect();
      json(response, 200, { unpaired: true });
      return;
    }
    if (url.pathname === "/v1/relay/events" && request.method === "GET") {
      if (desktop) {
        json(response, 409, { error: "This hub already has a connected Mac." });
        return;
      }
      desktop = response;
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      });
      send({ type: "ready" });
      delivery.start();
      const timer = setInterval(() => send({ type: "ready" }), 10_000);
      response.on("close", () => {
        clearInterval(timer);
        if (desktop === response) disconnect();
      });
      return;
    }
    const match = /^\/v1\/relay\/requests\/([a-f0-9-]{36})\/(body|response)$/.exec(url.pathname);
    const item = match && pending.get(match[1]);
    if (!match || !item) {
      json(response, 404, { error: "The publication request has ended." });
      return;
    }
    if (match[2] === "body" && request.method === "GET" && !item.bodyRead) {
      item.bodyRead = true;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.flushHeaders();
      if (Buffer.isBuffer(item.request)) {
        response.end(item.request);
        return;
      }
      await pipeline(
        item.request,
        bounded(
          item.path === "/v1/pull-requests"
            ? MAX_PULL_REQUESTS_REQUEST_BYTES
            : item.path === "/v1/plans"
              ? MAX_PLAN_REQUEST_BYTES
              : item.path === "/v1/voice"
                ? MAX_VOICE_REQUEST_BYTES
                : ["/v1/diagrams", "/v1/diagram-agents"].includes(item.path)
                  ? MAX_DIAGRAM_REQUEST_BYTES
                  : item.path.endsWith("/blobs") || item.path === "/v1/diagrams/sync"
                    ? MAX_CONTENT_BYTES
                    : MAX_METADATA_BYTES,
        ),
        response,
        { signal: item.controller.signal },
      ).catch(() =>
        finish(match[1], "The upload was interrupted. Check the artifact before retrying."),
      );
      return;
    }
    if (match[2] === "response" && request.method === "POST" && !item.answered) {
      const status = Number(request.headers["scope-response-status"]);
      if (!Number.isInteger(status) || status < 200 || status > 599)
        throw new Error("Invalid response status.");
      item.answered = true;
      if (typeof item.response === "function") {
        try {
          const body = JSON.parse((await readBody(request, MAX_METADATA_BYTES)).toString());
          if (!pending.has(match[1])) {
            json(response, 404, { error: "The buffered delivery was canceled." });
            return;
          }
          state.artifacts.observe(item.method, item.path, status, body);
          forget(match[1]);
          if (status >= 400)
            item.response(
              new ScopeError(
                status,
                typeof body.error === "string" ? body.error : `Scope returned ${status}.`,
              ),
            );
          else item.response(null, body);
          json(response, 200, { delivered: true });
        } catch {
          finish(match[1], "The desktop returned an invalid buffered delivery response.");
          json(response, 502, { error: "Invalid desktop response." });
        }
        return;
      }
      clearTimeout(item.timer);
      const headers: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      for (const name of ["content-type", "content-disposition", "content-security-policy"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      if (artifactMetadataRequest(item.method, item.path)) {
        try {
          const bytes = await readBody(request, MAX_METADATA_BYTES);
          if (!pending.has(match[1])) {
            json(response, 404, { error: "The publication request has ended." });
            return;
          }
          state.artifacts.observe(item.method, item.path, status, JSON.parse(bytes.toString()));
          forget(match[1]);
          item.response.writeHead(status, headers);
          item.response.end(bytes);
          json(response, 200, { delivered: true });
        } catch {
          finish(
            match[1],
            "The desktop returned an invalid artifact metadata response. Check the artifact before retrying an uncertain write.",
          );
          json(response, 502, { error: "Invalid desktop response." });
        }
        return;
      }
      item.response.writeHead(status, headers);
      await pipeline(request, item.response, { signal: item.controller.signal }).then(
        () => {
          forget(match[1]);
          json(response, 200, { delivered: true });
        },
        () => {
          finish(match[1]);
          json(response, 502, { error: "The caller disconnected." });
        },
      );
      return;
    }
    json(response, 409, { error: "The request was already claimed or the method is invalid." });
    return;
  }

  async function forwardArtifact(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ) {
    if (!state.authenticate(token, "local")) {
      json(response, 401, { error: "A valid publishing token is required." });
      return;
    }
    if (!artifactRequest(request.method ?? "", request.url ?? "")) {
      json(response, 404, { error: "Artifact endpoint not found." });
      return;
    }
    if (await buffered.handle(request, response, !desktop, Boolean(state.status().pairedMac))) {
      delivery.start();
      return;
    }
    if (!desktop) {
      const updateBase = /^\/v1\/(artifacts|names)\/([^/?]+)$/.exec(request.url ?? "");
      if (
        request.method === "GET" &&
        request.headers[UPDATE_BASE_HEADER.toLowerCase()] === "1" &&
        updateBase
      ) {
        json(response, 200, state.artifacts.read(updateBase[2], updateBase[1] === "names"));
        return;
      }
      json(response, 503, {
        error:
          "Scope on the paired Mac is disconnected. Open Scope and connect this remote. Only publications that request buffering can be queued.",
      });
      return;
    }
    if (pending.size >= 16) {
      json(response, 503, { error: "The hub is busy. Retry after the current requests finish." });
      return;
    }
    const limit =
      request.url === "/v1/pull-requests"
        ? MAX_PULL_REQUESTS_REQUEST_BYTES
        : request.url === "/v1/plans"
          ? MAX_PLAN_REQUEST_BYTES
          : MAX_CONTENT_BYTES;
    if (Number(request.headers["content-length"]) > limit) {
      json(response, 413, { error: `Request exceeds the ${limit / (1024 * 1024)} MiB limit.` });
      return;
    }
    const timeoutMs = maintenanceRequest(request.url ?? "")
      ? MAX_MAINTENANCE_TIMEOUT_MS + 5000
      : 30_000;
    request.setTimeout(timeoutMs);
    const id = randomUUID();
    const receivingDesktop = desktop;
    const item: Pending = {
      method: request.method!,
      path: request.url!,
      request,
      response,
      bodyRead: false,
      answered: false,
      controller: new AbortController(),
      timer: setTimeout(
        () =>
          requestTimedOut(
            id,
            receivingDesktop,
            "The Mac did not respond in time. Check the artifact before retrying.",
          ),
        timeoutMs,
      ),
    };
    pending.set(id, item);
    response.on("close", () => {
      if (!response.writableFinished) finish(id);
    });
    request.on("aborted", () => finish(id));
    send({
      type: "request",
      id,
      method: request.method as "GET" | "POST" | "PUT" | "DELETE",
      path: request.url!,
      ...(request.headers["content-type"] ? { contentType: request.headers["content-type"] } : {}),
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The hub has no TCP address.");
  state.maintenance.start();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      clearInterval(queueTimer);
      await delivery.close();
      await updates?.close();
      await state.maintenance.close();
      disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
