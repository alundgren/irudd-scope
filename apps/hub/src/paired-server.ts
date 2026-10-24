import {
  guestCommandRequest,
  GUEST_PLANS_CAPABILITY,
  GUEST_COMMAND_TIMEOUT_MS,
  MAX_GUEST_OPERATION_BYTES,
  MAX_GUEST_READ_BYTES,
} from "@irudd-scope/protocol/guest-operation";
import { MAX_PROMPT_REQUEST_BYTES } from "@irudd-scope/protocol/prompts";
import { MAX_PULL_REQUESTS_REQUEST_BYTES } from "@irudd-scope/protocol/pull-requests";
import { MAX_VOICE_REQUEST_BYTES } from "@irudd-scope/protocol/voice";
import {
  MAX_TRANSFER_IMPORT_REQUEST_BYTES,
  TRANSFER_IMPORT_TIMEOUT_MS,
} from "@irudd-scope/protocol/transfer";
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
  RELAY_CAPABILITIES_HEADER,
  RELAY_WAKE_HEADER,
} from "@irudd-scope/protocol/remote";
import {
  FOLDER_CAPABILITY,
  FOLDER_COMMAND_ROUTES,
  MAX_FOLDER_COMMAND_BYTES,
  MAX_FOLDER_WATCHES,
  FolderRelativePath,
  folderCommandRequest,
  folderQuery,
} from "@irudd-scope/protocol/folder";
import { FolderError, canonicalFolder, readFolderFile } from "@irudd-scope/folder";
import { FolderFileRoutes, folderFailure } from "./folder-routes.ts";
import type { HubState } from "./state.ts";
import type { HubUpdates } from "./updates.ts";
import type { MemorySync } from "@irudd-scope/memory-sync";
import { MemoryConfiguration, disabledMemory } from "@irudd-scope/protocol/memory";
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
  memory?: MemorySync,
) {
  memory?.configure(state.memoryConfiguration());
  let desktop: ServerResponse | undefined;
  // An older desktop drops the whole relay on an unknown request, so folder commands
  // go only to a desktop that advertised folder support when it connected.
  let desktopFolders = false;
  let desktopGuestPlans = false;
  const folderFiles = new FolderFileRoutes(state);
  const pending = new Map<string, Pending>();
  // Folder commands hold a slot while their body is read and their path resolved, so
  // concurrent commands can never put more than 16 requests on the relay.
  let reserved = 0;
  const relayFull = () => pending.size + reserved >= 16;
  // Folder watches stay open until a tab closes, so they have their own slots, reserved
  // the same way before their path is resolved.
  const watches = new Map<string, Pending>();
  let reservedWatches = 0;
  function forget(id: string) {
    const item = pending.get(id) ?? watches.get(id);
    pending.delete(id);
    watches.delete(id);
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
    desktopFolders = false;
    desktopGuestPlans = false;
    previous?.destroy();
    folderFiles.closeAll();
    for (const id of [...pending.keys(), ...watches.keys()])
      finish(
        id,
        "Scope on the Mac disconnected. Check the artifact before retrying an uncertain write.",
      );
  }
  function requestTimedOut(id: string, receivingDesktop: ServerResponse, error: string) {
    const item = pending.get(id) ?? watches.get(id);
    if (!item) return;
    const unstartedWrite = item.method !== "GET" && !item.bodyRead;
    finish(id, error);
    if (unstartedWrite && desktop === receivingDesktop) disconnect();
  }
  const relay: RelayCall = (method, path, body, signal) =>
    new Promise((resolve, reject) => {
      if (!desktop || relayFull() || signal.aborted) {
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
    if (url.pathname === "/v1/hub/memory" && request.method === "GET" && !url.search && memory) {
      json(response, 200, memory.status());
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
      memory?.configure(disabledMemory());
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
    if (url.pathname === "/v1/relay/memory" && !url.search && memory) {
      if (request.method === "PUT") {
        const body = await readBody(request, 4096);
        const configuration = decode(MemoryConfiguration, JSON.parse(body.toString()));
        if (JSON.stringify(state.memoryConfiguration()) !== JSON.stringify(configuration))
          state.saveMemoryConfiguration(configuration);
        memory.configure(configuration);
        json(response, 200, memory.status());
        return;
      }
      if (request.method === "GET") {
        json(response, 200, memory.status());
        return;
      }
    }
    if (
      url.pathname === "/v1/relay/memory/sync" &&
      request.method === "POST" &&
      !url.search &&
      memory
    ) {
      json(response, 200, await memory.sync());
      return;
    }
    if (url.pathname === "/v1/relay/disconnect" && request.method === "DELETE") {
      delivery.cancel();
      state.unpair();
      memory?.configure(disabledMemory());
      disconnect();
      json(response, 200, { unpaired: true });
      return;
    }
    if (await folderFiles.handle(request, response, url)) return;
    if (url.pathname === "/v1/relay/events" && request.method === "GET") {
      if (desktop) {
        json(response, 409, { error: "This hub already has a connected Mac." });
        return;
      }
      desktop = response;
      desktopGuestPlans = String(request.headers[RELAY_CAPABILITIES_HEADER.toLowerCase()] ?? "")
        .split(",")
        .some((value) => value.trim() === GUEST_PLANS_CAPABILITY);
      desktopFolders = String(request.headers[RELAY_CAPABILITIES_HEADER.toLowerCase()] ?? "")
        .split(",")
        .some((value) => value.trim() === FOLDER_CAPABILITY);
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      });
      send({ type: "ready" });
      if (request.headers[RELAY_WAKE_HEADER.toLowerCase()] === "1") delivery.wake();
      else delivery.start();
      const timer = setInterval(() => send({ type: "ready" }), 10_000);
      response.on("close", () => {
        clearInterval(timer);
        if (desktop === response) disconnect();
      });
      return;
    }
    const match = /^\/v1\/relay\/requests\/([a-f0-9-]{36})\/(body|response)$/.exec(url.pathname);
    const item = match && (pending.get(match[1]) ?? watches.get(match[1]));
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
          guestCommandRequest(item.method, item.path)
            ? MAX_GUEST_OPERATION_BYTES
            : item.path === "/v1/prompts"
              ? MAX_PROMPT_REQUEST_BYTES
              : item.path === "/v1/pull-requests"
                ? MAX_PULL_REQUESTS_REQUEST_BYTES
                : item.path === "/v1/voice"
                  ? MAX_VOICE_REQUEST_BYTES
                  : item.path.endsWith("/blobs")
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
      await pipeline(
        request,
        ...(guestCommandRequest(item.method, item.path)
          ? [
              bounded(
                item.path === "/v1/guests/read" ? MAX_GUEST_READ_BYTES : MAX_GUEST_OPERATION_BYTES,
              ),
            ]
          : []),
        item.response,
        { signal: item.controller.signal },
      ).then(
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
    if (folderCommandRequest(request.method ?? "", request.url ?? "")) {
      await forwardFolderCommand(request, response).catch((error: unknown) =>
        folderFailure(response, error),
      );
      return;
    }
    if (!artifactRequest(request.method ?? "", request.url ?? "")) {
      json(response, 404, { error: "Artifact endpoint not found." });
      return;
    }
    if (await buffered.handle(request, response, Boolean(state.status().pairedMac))) {
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
    if (guestCommandRequest(request.method ?? "", request.url ?? "") && !desktopGuestPlans) {
      json(response, 501, {
        error: "Update Scope on the paired desktop to use owner-targeted plans.",
      });
      return;
    }
    if (relayFull()) {
      json(response, 503, { error: "The hub is busy. Retry after the current requests finish." });
      return;
    }
    const limit = guestCommandRequest(request.method ?? "", request.url ?? "")
      ? MAX_GUEST_OPERATION_BYTES
      : request.url === "/v1/transfers/import"
        ? MAX_TRANSFER_IMPORT_REQUEST_BYTES
        : request.url === "/v1/prompts"
          ? MAX_PROMPT_REQUEST_BYTES
          : request.url === "/v1/pull-requests"
            ? MAX_PULL_REQUESTS_REQUEST_BYTES
            : MAX_CONTENT_BYTES;
    if (Number(request.headers["content-length"]) > limit) {
      json(response, 413, { error: `Request exceeds the ${limit / (1024 * 1024)} MiB limit.` });
      return;
    }
    const timeoutMs = guestCommandRequest(request.method ?? "", request.url ?? "")
      ? GUEST_COMMAND_TIMEOUT_MS
      : maintenanceRequest(request.url ?? "")
        ? MAX_MAINTENANCE_TIMEOUT_MS + 5000
        : request.url === "/v1/transfers/import"
          ? TRANSFER_IMPORT_TIMEOUT_MS
          : 30_000;
    request.setTimeout(timeoutMs);
    startForward(request, request, response, timeoutMs, request.headers["content-type"]);
  }

  /** Folder commands are live only: they are never queued and need a desktop that supports them. */
  async function forwardFolderCommand(request: IncomingMessage, response: ServerResponse) {
    if (!desktop)
      throw new FolderError(
        "desktop-offline",
        "Scope desktop is not connected. Open Scope and connect this remote, then retry.",
      );
    if (!desktopFolders)
      throw new FolderError("unsupported", "Update Scope on the paired desktop to share folders.");
    if (request.method === "GET") {
      await forwardFolderWatch(request, response);
      return;
    }
    if (relayFull()) {
      json(response, 503, { error: "The hub is busy. Retry after the current requests finish." });
      return;
    }
    reserved++;
    let body: Buffer;
    try {
      body = await canonicalCommand(request);
    } finally {
      reserved--;
    }
    if (!desktop || !desktopFolders)
      throw new FolderError("desktop-offline", "Scope desktop disconnected. Retry the command.");
    request.setTimeout(30_000);
    startForward(request, body, response, 30_000, "application/json");
  }

  /** Reads a folder command and replaces its path with the canonical path on this machine. */
  async function canonicalCommand(request: IncomingMessage): Promise<Buffer> {
    let input: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(
        (await readBody(request, MAX_FOLDER_COMMAND_BYTES)).toString(),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      input = value as Record<string, unknown>;
    } catch {
      throw new FolderError("not-found", "Send a folder command with an absolute path.");
    }
    if (typeof input.path !== "string" || input.path.length > 4096)
      throw new FolderError("not-found", "Send a folder command with an absolute path.");
    // The canonical path is computed on the machine that has the files.
    const path = await canonicalFolder(input.path);
    // A selected file is checked here too, so a missing or outside file opens no tab.
    if (request.url === FOLDER_COMMAND_ROUTES.select && typeof input.file === "string") {
      let file: string;
      try {
        file = decode(FolderRelativePath, input.file);
      } catch {
        throw new FolderError(
          "outside-folder",
          "Use a FILE path inside the folder, such as docs/plan.md.",
        );
      }
      await readFolderFile(path, file, 0, 0);
    }
    return Buffer.from(JSON.stringify({ ...input, path }));
  }

  /**
   * Relays `folder watch` as a long stream. The desktop's heartbeats keep both sockets
   * under the 30-second timeout; the deadline only covers the desktop starting its answer.
   */
  async function forwardFolderWatch(request: IncomingMessage, response: ServerResponse) {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const path = query.get("path");
    if (!path || [...query.keys()].some((name) => name !== "path" && name !== "machine"))
      throw new FolderError("not-found", "Send a folder watch with an absolute path.");
    if (watches.size + reservedWatches >= MAX_FOLDER_WATCHES) {
      json(response, 503, {
        error: `This hub already has ${MAX_FOLDER_WATCHES} folder watches. Stop one and retry.`,
      });
      return;
    }
    reservedWatches++;
    let canonical: string;
    try {
      canonical = await canonicalFolder(path);
    } finally {
      reservedWatches--;
    }
    const forwarded = `${FOLDER_COMMAND_ROUTES.watch}?${folderQuery({ path: canonical })}`;
    if (!desktop || !desktopFolders)
      throw new FolderError("desktop-offline", "Scope desktop disconnected. Retry the command.");
    // Shorter than the 30-second socket timeout, so the caller gets the failure.
    startForward(request, Buffer.alloc(0), response, 20_000, undefined, {
      path: forwarded,
      slots: watches,
    });
  }

  function startForward(
    request: IncomingMessage,
    body: IncomingMessage | Buffer,
    response: ServerResponse,
    timeoutMs: number,
    contentType: string | undefined,
    { path = request.url!, slots = pending }: { path?: string; slots?: Map<string, Pending> } = {},
  ) {
    const id = randomUUID();
    const receivingDesktop = desktop!;
    const item: Pending = {
      method: request.method!,
      path,
      request: body,
      response,
      bodyRead: false,
      answered: false,
      controller: new AbortController(),
      timer: setTimeout(
        () =>
          requestTimedOut(
            id,
            receivingDesktop,
            slots === watches
              ? "Scope desktop did not start the folder watch in time. Retry the command."
              : "The Mac did not respond in time. Check the artifact before retrying.",
          ),
        timeoutMs,
      ),
    };
    slots.set(id, item);
    response.on("close", () => {
      if (!response.writableFinished) finish(id);
    });
    request.on("aborted", () => finish(id));
    send({
      type: "request",
      id,
      method: request.method as "GET" | "POST" | "PUT" | "DELETE",
      path,
      ...(contentType ? { contentType } : {}),
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
      await memory?.close();
      await state.maintenance.close();
      disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
