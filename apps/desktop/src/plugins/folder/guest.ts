import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { readRemoteJson } from "@irudd-scope/protocol/remote";
import { FolderError } from "@irudd-scope/folder";
import {
  FolderErrorBody,
  FolderFeedEvent,
  FolderListing,
  FolderSearchEvent,
  type FolderIdentity,
} from "@irudd-scope/protocol/folder";
import {
  FolderOperationStatus,
  FolderVersionReceipt,
  FOLDER_UPLOAD_IDLE_MS,
  FOLDER_UPLOAD_TOTAL_MS,
} from "@irudd-scope/protocol/folder-operation";
import {
  GUEST_FOLDER_HEADER,
  GUEST_FOLDER_ROUTES,
  GuestFolderTarget,
  GuestFolderPath,
  GuestFolderList,
  GuestFolderRead,
  GuestFolderSearch,
  GuestFolderWrite,
  GuestFolderStatus,
  GuestFolderInfo,
  type GuestFolderRoute,
} from "@irudd-scope/protocol/guest-folder";
import type { GuestTarget } from "@irudd-scope/protocol/guest-operation";
import type { MainPluginContext } from "../main-api.ts";
import type { GuestOwnerRequest } from "../../guest/service.ts";
import { RemoteUnavailableError } from "../../remotes.ts";
import {
  FolderUpdateNeeded,
  localFolderSource,
  remoteFolderSource,
  readLines,
  MAX_FOLDER_IPC_READ,
  type FolderSource,
} from "./source.ts";

const settings = (route: GuestFolderRoute) =>
  route === "upload" || route === "read"
    ? { idleMs: FOLDER_UPLOAD_IDLE_MS, deadlineMs: FOLDER_UPLOAD_TOTAL_MS }
    : route === "events"
      ? { idleMs: 35_000, deadlineMs: 2_147_483_647 }
      : route === "search"
        ? { idleMs: 35_000, deadlineMs: 30 * 60_000 }
        : { idleMs: 20_000, deadlineMs: 60_000 };

function metadata<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  request: GuestOwnerRequest["request"],
): S["Type"] {
  const header = request.headers[GUEST_FOLDER_HEADER];
  if (typeof header !== "string" || header.length > 12_000 || !/^[\w-]+$/.test(header))
    throw new Error("Invalid folder request.");
  return decode(schema, JSON.parse(Buffer.from(header, "base64url").toString()));
}
function answer(response: GuestOwnerRequest["response"], value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

/** Explicit folder routes and the receiver's source adapter; roots remain on the owner. */
export class GuestFolders {
  private remove: (() => void)[] = [];
  private closed = new AbortController();
  private active = new Map<AbortController, { sourceTabId: string; sourceVersion: number }>();
  private slots = new Map<string, number>();
  constructor(
    private readonly context: MainPluginContext,
    private readonly written: (tabId: string, path: string) => void,
  ) {
    for (const route of Object.keys(GUEST_FOLDER_ROUTES) as GuestFolderRoute[])
      this.remove.push(
        context.guests.register(`folder-${route}`, {
          capability: GUEST_FOLDER_ROUTES[route],
          method: route === "upload" ? "PUT" : "POST",
          ...settings(route),
          handle: (request) => this.serve(route, request),
        }),
      );
    this.remove.push(
      context.artifacts.subscribe(() => {
        for (const [controller, expected] of this.active)
          void context.guestCatalogs.resolveSource(expected.sourceTabId).then(
            (source) => {
              if (source.kind !== "folder" || source.sourceVersion !== expected.sourceVersion)
                controller.abort();
            },
            () => controller.abort(),
          );
      }),
    );
  }
  host(identity: FolderIdentity) {
    return identity.machineId === "local"
      ? localFolderSource(identity.path, this.context.store.folderOperations)
      : remoteFolderSource(this.context.remotes, identity);
  }
  private async current(target: GuestTarget, version: number) {
    if (target.ownerDeviceId !== (await this.context.store.guestDevice()).deviceId)
      throw new Error("Wrong folder owner.");
    const source = await this.context.guestCatalogs.resolveSource(target.sourceTabId);
    if (source.kind !== "folder" || source.sourceVersion !== version)
      throw new FolderError(
        "conflict",
        "The source changed. Refresh this folder before continuing.",
      );
    const identity = await this.context.artifacts.folderIdentity(target.sourceTabId);
    if (!identity) throw new FolderError("no-tab", "This folder is no longer shared.");
    return identity;
  }
  private async serve(route: GuestFolderRoute, input: GuestOwnerRequest) {
    const { request, response, peer } = input;
    const key = `${peer.id}:${route === "events" ? "feeds" : "requests"}`;
    const limit = 16;
    if ((this.slots.get(key) ?? 0) >= limit)
      throw new Error("Too many folder requests. Try again shortly.");
    this.slots.set(key, (this.slots.get(key) ?? 0) + 1);
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal, this.closed.signal]);
    const abort = () => {
      request.destroy();
      response.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (route === "status") {
        const status = metadata(GuestFolderStatus, request);
        if (status.target.ownerDeviceId !== (await this.context.store.guestDevice()).deviceId)
          throw new Error("Wrong folder owner.");
        const binding = await this.context.store.guestRecovery.folderBinding(
          peer.deviceId,
          status.requestId,
        );
        if (!binding || binding.write.target.sourceTabId !== status.target.sourceTabId) {
          answer(response, {
            requestId: status.requestId,
            state: "unknown",
            expiresAt: Number(status.requestId.split(":")[0]) + 48 * 60 * 60_000,
          });
          return;
        }
        const outcome = await this.host(binding.identity).operations.status(
          peer.deviceId,
          status.requestId,
          signal,
        );
        signal.throwIfAborted();
        answer(response, outcome);
        return;
      }
      const expected =
        route === "list"
          ? metadata(GuestFolderList, request)
          : route === "read"
            ? metadata(GuestFolderRead, request)
            : route === "search"
              ? metadata(GuestFolderSearch, request)
              : route === "version"
                ? metadata(GuestFolderPath, request)
                : route === "upload" || route === "directory"
                  ? metadata(GuestFolderWrite, request)
                  : metadata(GuestFolderTarget, request);
      this.active.set(controller, {
        sourceTabId: expected.target.sourceTabId,
        sourceVersion: expected.sourceVersion,
      });
      const identity = await this.current(expected.target, expected.sourceVersion);
      signal.throwIfAborted();
      const source = this.host(identity);
      const check = async () => {
        await this.current(expected.target, expected.sourceVersion);
        signal.throwIfAborted();
      };
      if (route === "info") {
        const machine =
          identity.machineId === "local"
            ? "Owner computer"
            : (this.context.remotes.snapshot().find((remote) => remote.id === identity.machineId)
                ?.name ?? "Owner remote");
        await check();
        answer(response, { machine });
      } else if (route === "list") {
        const value = metadata(GuestFolderList, request);
        const listing = await source.list(value.path, value.showIgnored, signal);
        await check();
        answer(response, listing);
      } else if (route === "version") {
        const value = metadata(GuestFolderPath, request);
        const version = await source.operations.version(value.path, signal);
        await check();
        answer(response, { version });
      } else if (route === "upload" || route === "directory") {
        const write = metadata(GuestFolderWrite, request);
        if (write.operation.kind !== (route === "upload" ? "file" : "directory"))
          throw new Error("Wrong folder operation kind.");
        // The adapter gate runs before durable admission; old hubs never use legacy writes.
        await source.operations.version(write.operation.path, signal);
        await check();
        await this.context.store.guestRecovery.bindFolder({
          caller: peer.deviceId,
          write,
          identity,
        });
        await check();
        const body = new PassThrough();
        request.pipe(body);
        try {
          const outcome = await source.operations.execute(
            peer.deviceId,
            write.operation,
            body,
            signal,
          );
          await check();
          if (outcome.state === "completed")
            this.written(write.target.sourceTabId, write.operation.path);
          answer(response, outcome);
        } finally {
          request.unpipe(body);
          body.destroy();
          if (!request.complete) request.resume();
        }
      } else if (route === "read") {
        const value = metadata(GuestFolderRead, request);
        if (value.end !== undefined) {
          if (value.end < value.start || value.end - value.start > MAX_FOLDER_IPC_READ)
            throw new Error("Read at most 8 MiB at a time.");
          const file = await source.read(value.path, value.start, value.end, signal);
          await check();
          response.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Scope-Folder-Size": String(file.size),
            "Scope-Folder-Modified": String(file.modifiedAt),
          });
          response.end(file.bytes);
        } else {
          if (value.start !== 0) throw new Error("Downloads start at the beginning.");
          const file = await source.download(value.path, signal);
          try {
            await check();
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Scope-Folder-Size": String(file.size),
            });
            await pipeline(file.stream, response, { signal });
          } finally {
            file.stream.destroy();
          }
        }
      } else {
        const value = route === "search" ? metadata(GuestFolderSearch, request) : undefined;
        await check();
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        await this.feed(response, signal, controller, (emit) =>
          route === "search"
            ? source.search(
                {
                  query: value!.query,
                  showIgnored: value!.showIgnored,
                  ...(value!.names === undefined ? {} : { names: value!.names }),
                },
                emit,
                signal,
              )
            : source.events(emit, signal),
        );
      }
      if (!response.writableFinished) await once(response, "finish", { signal });
    } catch (error) {
      if (!response.headersSent && !signal.aborted) {
        const update = error instanceof FolderUpdateNeeded;
        const code =
          error instanceof FolderError ? error.code : update ? "unsupported" : "desktop-offline";
        response.writeHead(update ? 501 : 409, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            code,
            error: update
              ? "Update Scope on the owner's remote to use guest folders."
              : error instanceof FolderError
                ? error.message
                : "The owner folder is unavailable. Refresh its source and try again.",
          }),
        );
      } else response.destroy();
    } finally {
      this.slots.set(key, Math.max(0, (this.slots.get(key) ?? 1) - 1));
      this.active.delete(controller);
      signal.removeEventListener("abort", abort);
      if (!response.writableFinished && !response.destroyed)
        await once(response, "finish", { signal }).catch(() => {});
      controller.abort();
    }
  }
  private async feed(
    response: GuestOwnerRequest["response"],
    signal: AbortSignal,
    controller: AbortController,
    run: (emit: (event: FolderFeedEvent | FolderSearchEvent) => void) => Promise<void>,
  ) {
    const queue: string[] = [];
    let bytes = 0,
      done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const emit = (event: unknown) => {
      const line = JSON.stringify(event) + "\n";
      bytes += Buffer.byteLength(line);
      if (bytes > 1024 * 1024 || queue.length >= 256) {
        controller.abort();
        return;
      }
      queue.push(line);
      wake?.();
    };
    const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
    const aborted = () => wake?.();
    signal.addEventListener("abort", aborted, { once: true });
    const task = run(emit)
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        done = true;
        wake?.();
      });
    try {
      while (!done || queue.length) {
        signal.throwIfAborted();
        const line = queue.shift();
        if (!line) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        bytes -= Buffer.byteLength(line);
        if (!response.write(line)) await once(response, "drain", { signal });
      }
      if (failure) throw failure;
      response.end();
      if (!response.writableFinished) await once(response, "finish", { signal });
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      signal.removeEventListener("abort", aborted);
      await task;
    }
  }
  async source(tabId: string): Promise<{
    identity: FolderIdentity;
    source: FolderSource;
    guest: GuestFolderWrite["target"];
    sourceVersion: number;
  }> {
    const record = (await this.context.store.guestRecords()).find(
      (record) => record.tab.id === tabId,
    );
    if (!record || record.source.kind !== "folder")
      throw new FolderError("no-tab", "This guest folder no longer exists.");
    if (!this.context.guestCatalogs.snapshot().available.includes(tabId))
      throw new RemoteUnavailableError("The owner or source folder is unavailable.");
    const sourceVersion = record.source.sourceVersion;
    if (!sourceVersion) throw new FolderUpdateNeeded();
    const target = { ownerDeviceId: record.ownerDeviceId, sourceTabId: record.source.sourceTabId };
    return {
      identity: { machineId: record.ownerDeviceId, path: "/" },
      source: this.adapter(tabId, target, sourceVersion),
      guest: target,
      sourceVersion,
    };
  }
  private async request(
    target: GuestTarget,
    route: GuestFolderRoute,
    input: unknown,
    signal: AbortSignal,
    body?: Readable,
  ) {
    try {
      const peer = (await this.context.store.guestPeers()).find(
        (peer) => peer.deviceId === target.ownerDeviceId,
      );
      if (!peer) throw new RemoteUnavailableError("The owner is no longer paired.");
      const access = this.context.guests.access(peer.id);
      if (!this.context.guests.supports(peer.id, GUEST_FOLDER_ROUTES[route]))
        throw new FolderUpdateNeeded();
      const header = Buffer.from(JSON.stringify(input)).toString("base64url");
      if (header.length > 12_000) throw new Error("Folder request is too large.");
      const result = await this.context.guests.request(peer.id, `folder-${route}`, {
        method: route === "upload" ? "PUT" : "POST",
        headers: { [GUEST_FOLDER_HEADER]: header },
        body,
        signal: AbortSignal.any([signal, access, this.closed.signal]),
        ...settings(route),
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(result.headers))
        if (typeof value === "string") headers.set(name, value);
      const response = new Response(Readable.toWeb(result.body) as ReadableStream<Uint8Array>, {
        status: result.status,
        headers,
      });
      if (!response.ok) {
        const error = decode(FolderErrorBody, await readRemoteJson(response, 8192));
        if (error.code === "unsupported") throw new FolderUpdateNeeded();
        if (error.code === "desktop-offline") throw new RemoteUnavailableError(error.error);
        throw new FolderError(error.code, error.error);
      }
      return response;
    } catch (error) {
      body?.destroy();
      throw error;
    }
  }
  private adapter(tabId: string, target: GuestTarget, sourceVersion: number): FolderSource {
    const expected = { target, sourceVersion };
    const validate = () => {
      const view = this.context.guestCatalogs.snapshot();
      const record = view.records.find((record) => record.tab.id === tabId);
      if (!view.available.includes(tabId) || record?.source.sourceVersion !== sourceVersion)
        throw new RemoteUnavailableError("This source changed. Refresh the folder.");
    };
    const call = async (
      route: GuestFolderRoute,
      input: object,
      signal: AbortSignal,
      body?: Readable,
    ) => {
      const response = await this.request(target, route, { ...expected, ...input }, signal, body);
      try {
        validate();
        return response;
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
    };
    const json = async (response: Response, limit: number) => {
      const value = await readRemoteJson(response, limit);
      validate();
      return value;
    };
    const source: FolderSource = {
      operations: {
        version: async (path, signal) =>
          decode(FolderVersionReceipt, await json(await call("version", { path }, signal), 8192))
            .version,
        execute: async (_caller, operation, body, signal) => {
          try {
            return decode(
              FolderOperationStatus,
              await json(
                await call(
                  operation.kind === "file" ? "upload" : "directory",
                  { operation },
                  signal,
                  body,
                ),
                8192,
              ),
            );
          } finally {
            body.destroy();
          }
        },
        status: async (_caller, requestId, signal) =>
          decode(
            FolderOperationStatus,
            await readRemoteJson(
              await this.request(target, "status", { target, requestId }, signal),
              8192,
            ),
          ),
      },
      list: async (path, showIgnored, signal) =>
        decode(
          FolderListing,
          await json(await call("list", { path, showIgnored }, signal), 32 * 1024 * 1024),
        ),
      read: async (path, start, end, signal) => {
        const response = await call("read", { path, start, end }, signal);
        const bytes = new Uint8Array(await response.arrayBuffer());
        validate();
        if (bytes.length > MAX_FOLDER_IPC_READ)
          throw new Error("Owner sent too many preview bytes.");
        return {
          bytes,
          start,
          size: Number(response.headers.get("Scope-Folder-Size")),
          modifiedAt: Number(response.headers.get("Scope-Folder-Modified")),
        };
      },
      download: async (path, signal) => {
        const response = await call("read", { path, start: 0 }, signal);
        return {
          size: Number(response.headers.get("Scope-Folder-Size")),
          stream: Readable.fromWeb(response.body! as NodeReadableStream),
        };
      },
      events: async (emit, signal) => {
        emit({ type: "changes", changes: [], overflow: true });
        await readLines(await call("events", {}, signal), signal, (line) => {
          validate();
          emit(decode(FolderFeedEvent, JSON.parse(line)));
        });
        if (!signal.aborted)
          throw new RemoteUnavailableError("The owner folder feed ended. Refreshing its files.");
      },
      search: async (input, emit, signal) => {
        const done = await readLines(await call("search", input, signal), signal, (line) => {
          validate();
          const value = JSON.parse(line);
          if (value.type === "heartbeat") return;
          const event = decode(FolderSearchEvent, value);
          emit(event);
          return event.type === "done";
        });
        if (!done && !signal.aborted)
          throw new RemoteUnavailableError("The owner stopped searching.");
      },
      walk: async (start, showIgnored, visit, signal) => {
        const paths = [start];
        while (paths.length) {
          signal.throwIfAborted();
          const path = paths.shift()!;
          const listing = await source.list(path, showIgnored, signal);
          visit({
            path,
            truncated: listing.truncated,
            entries: listing.entries.map((entry) => ({
              name: entry.name,
              directory: entry.kind === "directory",
              ignored: entry.ignored,
            })),
          });
          for (const entry of listing.entries)
            if (entry.kind === "directory") paths.push(entry.path);
        }
      },
      write: async (_path, body) => {
        body.destroy();
        throw new Error("Guest uploads require a versioned operation.");
      },
      createDirectory: async () => {
        throw new Error("Guest folders require a versioned directory operation.");
      },
    };
    return source;
  }
  async info(tabId: string) {
    const folder = await this.source(tabId);
    return decode(
      GuestFolderInfo,
      await readRemoteJson(
        await this.request(
          folder.guest,
          "info",
          { target: folder.guest, sourceVersion: folder.sourceVersion },
          AbortSignal.timeout(60_000),
        ),
        8192,
      ),
    );
  }
  async status(tabId: string) {
    const pending = await this.context.store.guestRecovery.folderRead(tabId);
    if (!pending) return;
    const { target, operation } = pending.write;
    const outcome = decode(
      FolderOperationStatus,
      await readRemoteJson(
        await this.request(
          target,
          "status",
          { target, requestId: operation.requestId },
          AbortSignal.timeout(60_000),
        ),
        8192,
      ),
    );
    if (outcome.requestId !== operation.requestId)
      throw new Error("The host returned a different operation identity.");
    await this.context.store.guestRecovery.folderSave({ ...pending, outcome });
    return { ...pending, outcome };
  }
  close() {
    this.closed.abort();
    for (const remove of this.remove) remove();
  }
}
