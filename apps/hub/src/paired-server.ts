import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decode, MAX_CONTENT_BYTES, MAX_METADATA_BYTES } from "@irudd-scope/protocol";
import {
  ShrinkRequest,
  ShrinkReceipt,
  MAX_MAINTENANCE_TIMEOUT_MS,
} from "@irudd-scope/protocol/maintenance";
import {
  artifactRequest,
  maintenanceRequest,
  PairRequest,
  type RelayEvent,
} from "@irudd-scope/protocol/remote";
import type { HubState } from "./state.ts";

type Pending = {
  request: IncomingMessage;
  response: ServerResponse;
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

export async function startPairedHub(state: HubState, port = state.configuration().port) {
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
    if (error) json(item.response, 503, { error });
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
        "Scope on the Mac disconnected. Requests are not queued. Check the artifact before retrying an uncertain write.",
      );
  }
  const server = createServer(
    { requestTimeout: 0, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void handle(request, response).catch(() => {
        json(response, 400, { error: "The hub could not complete the request." });
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
    if (url.pathname === "/v1/pair" && request.method === "POST") {
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
    if (url.pathname.startsWith("/v1/hub/")) {
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
        json(response, 200, { ...state.status(), connected: Boolean(desktop) });
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
        state.unpair();
        disconnect();
        json(response, 200, { unpaired: true });
        return;
      }
      json(response, 404, { error: "Endpoint not found." });
      return;
    }
    if (url.pathname.startsWith("/v1/relay/")) {
      if (!state.authenticate(token, "desktop")) {
        json(response, 401, { error: "Pair this Mac with the hub again." });
        return;
      }
      if (url.pathname === "/v1/relay/disconnect" && request.method === "DELETE") {
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
        await pipeline(
          item.request,
          bounded(item.request.url?.endsWith("/blobs") ? MAX_CONTENT_BYTES : MAX_METADATA_BYTES),
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
        clearTimeout(item.timer);
        const headers: Record<string, string> = {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        };
        for (const name of ["content-type", "content-disposition", "content-security-policy"]) {
          const value = request.headers[name];
          if (typeof value === "string") headers[name] = value;
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
    if (!state.authenticate(token, "local")) {
      json(response, 401, { error: "A valid publishing token is required." });
      return;
    }
    if (!artifactRequest(request.method ?? "", request.url ?? "")) {
      json(response, 404, { error: "Artifact endpoint not found." });
      return;
    }
    if (!desktop) {
      json(response, 503, {
        error:
          "Scope on the paired Mac is disconnected. Open Scope and connect this remote. Requests are not queued.",
      });
      return;
    }
    if (pending.size >= 16) {
      json(response, 503, { error: "The hub is busy. Retry after the current requests finish." });
      return;
    }
    if (Number(request.headers["content-length"]) > MAX_CONTENT_BYTES) {
      json(response, 413, { error: "Artifact exceeds the 32 MiB limit." });
      return;
    }
    const timeoutMs = maintenanceRequest(request.url ?? "")
      ? MAX_MAINTENANCE_TIMEOUT_MS + 5000
      : 30_000;
    request.setTimeout(timeoutMs);
    const id = randomUUID();
    const item: Pending = {
      request,
      response,
      bodyRead: false,
      answered: false,
      controller: new AbortController(),
      timer: setTimeout(
        () => finish(id, "The Mac did not respond in time. Check the artifact before retrying."),
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
      await state.maintenance.close();
      disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
