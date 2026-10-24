import { handlePromptHttp } from "./prompt-http.ts";
import { RetroCommand, RetroReply, MAX_RETRO_REQUEST_BYTES } from "@irudd-scope/protocol/retro";
import type { RetroConfiguration } from "@irudd-scope/protocol/retro";
import { MemoryConnectRequest, MemoryStatus } from "@irudd-scope/protocol/memory";
import { LibrarianCommand, LibrarianReply } from "@irudd-scope/protocol/librarian";
import { handlePullRequestsHttp } from "./pull-requests-http.ts";
import {
  VoiceRequest,
  VoiceRequestId,
  VoiceReceipt,
  MAX_VOICE_REQUEST_BYTES,
} from "@irudd-scope/protocol/voice";
import type { VoiceService } from "../voice/service.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { RemoteId } from "@irudd-scope/protocol/remote";
import {
  FOLDER_COMMAND_ROUTES,
  FOLDER_HEARTBEAT_MS,
  MAX_FOLDER_COMMAND_BYTES,
  folderErrorBody,
  type FolderWatchEvent,
  type MachineId,
} from "@irudd-scope/protocol/folder";
import { RELAY_ORIGIN_HEADER } from "../remote-contract.ts";
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
import { ArtifactName } from "@irudd-scope/protocol";
import {
  decodeTransferImportRequest,
  TransferImportReceipt,
  MAX_TRANSFER_IMPORT_REQUEST_BYTES,
} from "@irudd-scope/protocol/transfer";

export async function startArtifactServer(options: {
  librarian?: (command: LibrarianCommand) => Promise<LibrarianReply>;
  retroConfiguration?: {
    read: () => Promise<RetroConfiguration>;
    configure: (
      command: Extract<RetroCommand, { action: "configure" }>,
    ) => Promise<RetroConfiguration>;
  };
  importLink?: (url: string) => Promise<TransferImportReceipt>;
  memory?: {
    status: () => MemoryStatus | Promise<MemoryStatus>;
    connect: (repository: string) => Promise<MemoryStatus>;
  };
  voice?: VoiceService;
  directory: string;
  token: string;
  port?: number;
  initialize?: (store: ArtifactStore) => Promise<void>;
  shrink?: (timeoutMs: number) => Promise<ShrinkReceipt>;
  maintenanceStatus?: () => DatabaseShrink[];
  deleteArtifact?: (id: string) => Promise<{ id: string; deleted: boolean }>;
  /** Runs an agent folder command for the machine that delivered it. */
  folders?: (
    command: Exclude<keyof typeof FOLDER_COMMAND_ROUTES, "watch">,
    input: unknown,
    machineId: MachineId,
  ) => Promise<unknown>;
  /** Starts an agent's watch on a folder's open tab; events end when the tab closes. */
  watchFolder?: (
    input: unknown,
    machineId: MachineId,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<FolderWatchEvent>>;
}) {
  const originSecret = randomBytes(32).toString("base64url");
  if (options.token.length < 24 || /[\r\n]/.test(options.token))
    throw new Error("Use a publishing token with at least 24 characters and no newlines.");
  const store = await ArtifactStore.open(options.directory);
  store.retros.setConfiguration(options.retroConfiguration);
  try {
    await options.initialize?.(store);
    await store.reclaim();
  } catch (error) {
    await store.close();
    throw error;
  }
  const streams = new Set<ServerResponse>();
  let watches = 0;
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
    if (route === "POST /v1/retros" && !url.search) {
      const body = await readJson(
        request,
        MAX_RETRO_REQUEST_BYTES,
        "Retrospective request exceeds 2 MiB.",
      );
      const input = validate(() => decode(RetroCommand, body));
      json(response, 200, decode(RetroReply, await store.retros.command(input)));
      return;
    }
    if ((route === "GET /v1/memory" || route === "POST /v1/memory/connection") && !url.search) {
      if (!options.memory) throw new ScopeError(503, "Memory is unavailable in this Scope.");
      if (request.method === "GET") {
        json(response, 200, decode(MemoryStatus, await options.memory.status()));
        return;
      }
      const body = await readJson(request, 4096, "Memory request exceeds 4 KiB.");
      const input = validate(() => decode(MemoryConnectRequest, body));
      json(response, 200, decode(MemoryStatus, await options.memory.connect(input.repository)));
      return;
    }
    if (route === "POST /v1/librarian" && !url.search) {
      if (!options.librarian)
        throw new ScopeError(503, "Librarian is unavailable. Open Scope and retry.");
      const body = await readJson(request, 2 * 1024 * 1024, "Librarian command exceeds 2 MiB.");
      const input = validate(() => decode(LibrarianCommand, body));
      json(response, 200, decode(LibrarianReply, await options.librarian(input)));
      return;
    }
    if (url.pathname.startsWith("/v1/folders/")) {
      await folderCommand(request, response, url);
      return;
    }
    if (await handlePromptHttp(request, response, url, store.prompts)) return;
    if (await handlePullRequestsHttp(request, response, url, store.pullRequests)) return;

    if (route === "POST /v1/transfers/import" && !url.search) {
      if (!options.importLink)
        throw new ScopeError(
          503,
          "Link import is unavailable. Update and open Scope on the receiver.",
        );
      const body = await readJson(
        request,
        MAX_TRANSFER_IMPORT_REQUEST_BYTES,
        "Transfer import request exceeds 16 KiB.",
      );
      let input;
      try {
        input = decodeTransferImportRequest(body);
      } catch {
        throw new ScopeError(
          400,
          "Provide a valid tab sharing link. Complete pairing in Scope first.",
        );
      }
      let receipt;
      try {
        receipt = await options.importLink(input.url);
      } catch (error) {
        if (error instanceof ScopeError) throw error;
        throw new ScopeError(400, error instanceof Error ? error.message : "The transfer failed.");
      }
      json(response, 200, decode(TransferImportReceipt, receipt));
      return;
    }

    if (route === "POST /v1/voice" && !url.search) {
      if (!options.voice) throw new ScopeError(503, "Voice generation is unavailable.");
      const body = await readJson(
        request,
        MAX_VOICE_REQUEST_BYTES,
        "Speech request exceeds 128 KiB.",
      );
      const input = validate(() => decode(VoiceRequest, body));
      json(response, 202, decode(VoiceReceipt, await options.voice.submit(input)));
      return;
    }
    const speech = /^\/v1\/voice\/([^/]+)(\/result|\/billing)?$/.exec(url.pathname);
    if (speech && !url.search) {
      if (!options.voice) throw new ScopeError(503, "Voice generation is unavailable.");
      const id = validate(() => decode(VoiceRequestId, speech[1]));
      if (request.method === "GET" && speech[2] === "/result") {
        const bytes = await options.voice.result(id);
        response.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": bytes.byteLength,
          "Content-Disposition": "attachment",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
      } else if (request.method === "GET" && !speech[2]) {
        json(response, 200, await options.voice.status(id));
      } else if (request.method === "DELETE" && !speech[2]) {
        json(response, 200, await options.voice.cancel(id));
      } else if (request.method === "POST" && speech[2] === "/billing") {
        json(response, 202, await options.voice.refreshBilling(id));
      } else throw new ScopeError(405, "Method not supported.");
      return;
    }
    const named = /^\/v1\/names\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && named && !url.search) {
      const name = validate(() => decode(ArtifactName, decodeURIComponent(named[1])));
      json(response, 200, await store.named(name));
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

  // The machine comes from the connection that delivered the command, never from its body.
  function commandMachine(request: IncomingMessage): MachineId {
    const value = request.headers[RELAY_ORIGIN_HEADER.toLowerCase()];
    if (typeof value !== "string") return "local";
    const separator = value.lastIndexOf(":");
    const secret = Buffer.from(value.slice(0, Math.max(0, separator)));
    const expected = Buffer.from(originSecret);
    if (secret.length !== expected.length || !timingSafeEqual(secret, expected)) return "local";
    try {
      return decode(RemoteId, value.slice(separator + 1));
    } catch {
      return "local";
    }
  }

  async function folderCommand(request: IncomingMessage, response: ServerResponse, url: URL) {
    const command = (
      Object.keys(FOLDER_COMMAND_ROUTES) as (keyof typeof FOLDER_COMMAND_ROUTES)[]
    ).find((name) => FOLDER_COMMAND_ROUTES[name] === url.pathname);
    const method = command === "watch" ? "GET" : "POST";
    try {
      if (!command || request.method !== method)
        throw new ScopeError(404, "Folder endpoint not found.", "unsupported");
      if (!options.folders || !options.watchFolder)
        throw new ScopeError(501, "Folders are unavailable in this Scope.", "unsupported");
      if (command === "watch") {
        await watchFolder(request, response, url, options.watchFolder);
        return;
      }
      const input = await readJson(
        request,
        MAX_FOLDER_COMMAND_BYTES,
        "Folder command exceeds 16 KiB.",
      );
      json(response, 200, await options.folders(command, input, commandMachine(request)));
    } catch (error) {
      const status =
        error instanceof ScopeError
          ? error.status
          : error &&
              typeof error === "object" &&
              "status" in error &&
              typeof error.status === "number"
            ? error.status
            : 500;
      json(response, status, folderErrorBody(error, status === 400 ? "not-found" : "failed"));
    }
  }

  /** Streams NDJSON watch events with heartbeats until the tab closes or the caller leaves. */
  async function watchFolder(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    start: NonNullable<typeof options.watchFolder>,
  ) {
    if (watches >= MAX_LOCAL_FOLDER_WATCHES)
      throw new ScopeError(503, "Too many folder watches. Stop one and retry.", "failed");
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    watches++;
    try {
      const events = await start(
        Object.fromEntries(url.searchParams),
        commandMachine(request),
        controller.signal,
      );
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.flushHeaders();
      const heartbeat = setInterval(
        () => response.write(`${JSON.stringify({ type: "heartbeat" })}\n`),
        FOLDER_HEARTBEAT_MS,
      );
      try {
        for await (const event of events) response.write(`${JSON.stringify(event)}\n`);
      } catch {
        // Ending without `closed` tells the agent the watch stopped.
        response.destroy();
      } finally {
        clearInterval(heartbeat);
        response.end();
      }
    } finally {
      watches--;
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
    originSecret,
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

// Local agents plus watches relayed from every paired remote, each hub sending at most 16.
const MAX_LOCAL_FOLDER_WATCHES = 128;

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
