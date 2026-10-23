import { clipboard } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  FolderFindRequest,
  FolderOpenRequest,
  FolderRelativePath,
  FolderSelectRequest,
  type FolderFindReceipt,
  type FolderIdentity,
  type FolderOpenReceipt,
  type FolderSelectReceipt,
  type FolderWatchEvent,
  type MachineId,
} from "@irudd-scope/protocol/folder";
import { FolderError, canonicalFolder, readFolderFile } from "@irudd-scope/folder";
import { Uuid } from "../../workspace/contract.ts";
import { RemoteUnavailableError } from "../../remotes.ts";
import type { MainPluginContext } from "../main-api.ts";
import type {
  FolderListResult,
  FolderSelection,
  FolderUnavailable,
  FolderViewEvent,
} from "./contract.ts";
import { registerFolderFind } from "./find.ts";
import {
  FolderUpdateNeeded,
  MAX_FOLDER_IPC_READ,
  localFolderSource,
  remoteFolderSource,
} from "./source.ts";

const ListRequest = Schema.Struct({
  tabId: Uuid,
  path: FolderRelativePath,
  showIgnored: Schema.Boolean,
});
const ReadRequest = Schema.Struct({
  tabId: Uuid,
  path: Schema.String.check(Schema.isMaxLength(4096)),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

function unavailable(
  error: unknown,
  root: boolean,
): { status: FolderUnavailable; message: string } {
  const message = error instanceof Error ? error.message : "The folder could not be read.";
  if (error instanceof RemoteUnavailableError) return { status: "offline", message };
  if (error instanceof FolderUpdateNeeded) return { status: "update", message };
  if (error instanceof FolderError) {
    if (error.code === "not-found") return { status: root ? "gone" : "missing", message };
    if (error.code === "outside-folder") return { status: "outside", message };
    if (error.code === "unsupported") return { status: "update", message };
  }
  if (error instanceof TypeError) return { status: "offline", message };
  return { status: "error", message };
}

// Listings and reads for one machine wait their turn instead of failing, which leaves the
// remote's other streamed requests free for change feeds.
const MAX_FILE_REQUESTS = 8;

function machineLimiter() {
  const queues = new Map<string, { active: number; waiting: (() => void)[] }>();
  return async <T>(machineId: string, task: () => Promise<T>): Promise<T> => {
    const queue = queues.get(machineId) ?? { active: 0, waiting: [] };
    queues.set(machineId, queue);
    if (queue.active >= MAX_FILE_REQUESTS)
      await new Promise<void>((resolve) => queue.waiting.push(resolve));
    queue.active++;
    try {
      return await task();
    } finally {
      queue.active--;
      queue.waiting.shift()?.();
    }
  };
}

export function registerFolderIpc({
  handle,
  window,
  artifacts,
  lifecycle,
  remotes,
}: MainPluginContext) {
  const feeds = new Map<string, AbortController>();
  const limited = machineLimiter();
  async function folder(tabId: string) {
    const identity = await artifacts.folderIdentity(tabId);
    if (!identity) throw new FolderError("no-tab", "This Folder tab no longer exists.");
    return {
      identity,
      source:
        identity.machineId === "local"
          ? localFolderSource(identity.path)
          : remoteFolderSource(remotes, identity),
    };
  }
  const find = registerFolderFind({ handle, window }, folder, unavailable);
  function send(tabId: string, event: FolderViewEvent["event"]) {
    find.apply(tabId, event);
    if (!window.isDestroyed()) window.webContents.send("scope:folder-event", { tabId, event });
  }
  async function runFeed(tabId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const { source } = await folder(tabId);
        await source.events((event) => send(tabId, event), signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof FolderError && error.code === "no-tab") return;
        const { status, message } = unavailable(error, true);
        send(tabId, { type: "unavailable", reason: status, message });
      }
      await delay(3000, undefined, { signal }).catch(() => {});
    }
  }
  function stopFeed(tabId: string) {
    feeds.get(tabId)?.abort();
    feeds.delete(tabId);
    find.stop(tabId);
  }

  handle("scope:folder-list", async (input): Promise<FolderListResult> => {
    const request = decode(ListRequest, input);
    try {
      const { identity, source } = await folder(request.tabId);
      const listing = await limited(identity.machineId, () =>
        source.list(request.path, request.showIgnored, AbortSignal.timeout(60_000)),
      );
      return { status: "ok", listing };
    } catch (error) {
      return unavailable(error, request.path === "");
    }
  });
  handle("scope:folder-read", async (input) => {
    const request = decode(ReadRequest, input);
    try {
      decode(FolderRelativePath, request.path);
    } catch {
      throw new FolderError("outside-folder", "Use a path inside the folder.");
    }
    if (request.end - request.start > MAX_FOLDER_IPC_READ)
      throw new Error("Read at most 8 MiB at a time.");
    const { identity, source } = await folder(request.tabId);
    // packages/folder rejects `..`, absolute paths, and paths that leave the folder.
    return limited(identity.machineId, () =>
      source.read(request.path, request.start, request.end, AbortSignal.timeout(120_000)),
    );
  });
  handle("scope:folder-watch", (input) => {
    const tabId = decode(Uuid, input);
    if (feeds.has(tabId)) return;
    const controller = new AbortController();
    feeds.set(tabId, controller);
    void runFeed(tabId, controller.signal);
  });
  handle("scope:folder-unwatch", (input) => stopFeed(decode(Uuid, input)));
  handle("scope:folder-copy-path", async (input) => {
    await clipboard.writeText((await folder(decode(Uuid, input))).identity.path);
  });

  function commandInput<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    input: unknown,
  ): S["Type"] {
    try {
      return decode(schema, input);
    } catch {
      const file =
        input && typeof input === "object" && "file" in input && typeof input.file === "string";
      throw file
        ? new FolderError(
            "outside-folder",
            "Use a FILE path inside the folder, such as docs/plan.md.",
          )
        : new ScopeError(
            400,
            "Send an absolute folder path and a title of at most 160 characters.",
            "not-found",
          );
    }
  }
  // Hubs send the canonical path computed on their machine; local paths are resolved here.
  async function identity(path: string, machineId: MachineId): Promise<FolderIdentity> {
    return { machineId, path: machineId === "local" ? await canonicalFolder(path) : path };
  }
  async function open(
    folder: FolderIdentity,
    request: { title?: string },
    select?: FolderSelection,
  ): Promise<FolderOpenReceipt> {
    const opened = await lifecycle.openFolderTab({
      ...folder,
      ...(request.title ? { title: request.title } : {}),
      ...(select ? { select } : {}),
    });
    if (!window.isDestroyed()) window.webContents.send("scope:folder-tab-opened", opened);
    return {
      tabId: opened.tab.id,
      machine: folder.machineId,
      path: folder.path,
      created: opened.created,
    };
  }

  /** Whether ignore rules hide a file, read from its parent's listing on its machine. */
  async function selectedFileIgnored(folder: FolderIdentity, file: string): Promise<boolean> {
    const source =
      folder.machineId === "local"
        ? localFolderSource(folder.path)
        : remoteFolderSource(remotes, folder);
    const parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const listing = await source
      .list(parent, true, AbortSignal.timeout(30_000))
      .catch(() => undefined);
    return listing?.entries.find((entry) => entry.path === file)?.ignored ?? false;
  }

  async function command(
    name: "open" | "find" | "select",
    input: unknown,
    machineId: MachineId,
  ): Promise<FolderOpenReceipt | FolderFindReceipt | FolderSelectReceipt> {
    if (name === "find") {
      const folder = await identity(commandInput(FolderFindRequest, input).path, machineId);
      const tab = await artifacts.findFolderTab(folder);
      return {
        open: Boolean(tab?.open),
        ...(tab?.open ? { tabId: tab.tabId } : {}),
        machine: machineId,
        path: folder.path,
      };
    }
    if (name === "select") {
      const request = commandInput(FolderSelectRequest, input);
      const folder = await identity(request.path, machineId);
      // A hub checks the file on its machine before forwarding; local files are checked here.
      if (machineId === "local") await readFolderFile(folder.path, request.file, 0, 0);
      const ignored = await selectedFileIgnored(folder, request.file);
      return {
        ...(await open(folder, request, { file: request.file, ignored })),
        file: request.file,
      };
    }
    const request = commandInput(FolderOpenRequest, input);
    return open(await identity(request.path, machineId), request);
  }

  const watchers = new Map<string, Set<(event: FolderWatchEvent) => void>>();
  /** Sends an event to every agent watching a Folder tab. */
  function notifyWatchers(tabId: string, event: FolderWatchEvent) {
    for (const listener of watchers.get(tabId) ?? []) listener(event);
  }
  /**
   * Ends the watches of tabs that were just trashed, deleted, or closed to the drawer.
   * Each watch ends at the close itself, even when an agent reopens the tab right after.
   */
  function tabsClosed(ids: readonly string[]) {
    for (const id of ids) notifyWatchers(id, { type: "closed" });
  }

  /**
   * Starts an agent's watch on a folder's open tab. Events end with `closed` when the tab
   * leaves the strip. The HTTP server owns heartbeats and the connection.
   */
  async function watch(
    input: unknown,
    machineId: MachineId,
    signal: AbortSignal,
  ): Promise<AsyncIterable<FolderWatchEvent>> {
    const folder = await identity(commandInput(FolderFindRequest, input).path, machineId);
    const tab = await artifacts.findFolderTab(folder);
    if (!tab?.open)
      throw new FolderError(
        "no-tab",
        "This folder has no open Folder tab. Run irudd-scope folder open first.",
      );
    const queue: FolderWatchEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: FolderWatchEvent) => {
      queue.push(event);
      wake?.();
    };
    const listeners = watchers.get(tab.tabId) ?? new Set();
    listeners.add(listener);
    watchers.set(tab.tabId, listeners);
    const stop = () => wake?.();
    signal.addEventListener("abort", stop, { once: true });
    return (async function* () {
      try {
        while (!signal.aborted) {
          const event = queue.shift();
          if (!event) {
            await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
            continue;
          }
          yield event;
          if (event.type === "closed") return;
        }
      } finally {
        signal.removeEventListener("abort", stop);
        listeners.delete(listener);
        if (!listeners.size && watchers.get(tab.tabId) === listeners) watchers.delete(tab.tabId);
      }
    })();
  }

  return {
    command,
    watch,
    tabsClosed,
    cancelTabs: (ids: readonly string[]) => {
      for (const id of ids) stopFeed(id);
      tabsClosed(ids);
    },
    dispose: () => {
      for (const id of feeds.keys()) stopFeed(id);
    },
  };
}
