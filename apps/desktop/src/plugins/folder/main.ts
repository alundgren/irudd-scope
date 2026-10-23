import { clipboard } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  FOLDER_COMMAND_ROUTES,
  FolderOpenRequest,
  FolderRelativePath,
  type FolderOpenReceipt,
  type MachineId,
} from "@irudd-scope/protocol/folder";
import { FolderError, canonicalFolder } from "@irudd-scope/folder";
import { Uuid } from "../../workspace/contract.ts";
import { RemoteUnavailableError } from "../../remotes.ts";
import type { MainPluginContext } from "../main-api.ts";
import type { FolderListResult, FolderUnavailable, FolderViewEvent } from "./contract.ts";
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

  async function command(
    name: keyof typeof FOLDER_COMMAND_ROUTES,
    input: unknown,
    machineId: MachineId,
  ): Promise<FolderOpenReceipt> {
    if (name !== "open")
      throw new ScopeError(501, `Folder ${name} is not available yet.`, "unsupported");
    let request: FolderOpenRequest;
    try {
      request = decode(FolderOpenRequest, input);
    } catch {
      throw new ScopeError(
        400,
        "Send an absolute folder path and a title of at most 160 characters.",
        "not-found",
      );
    }
    // Hubs send the canonical path computed on their machine; local paths are resolved here.
    const path = machineId === "local" ? await canonicalFolder(request.path) : request.path;
    const opened = await lifecycle.openFolderTab({
      machineId,
      path,
      ...(request.title ? { title: request.title } : {}),
    });
    if (!window.isDestroyed()) window.webContents.send("scope:folder-tab-opened", opened);
    return { tabId: opened.tab.id, machine: machineId, path, created: opened.created };
  }

  return {
    command,
    cancelTabs: (ids: readonly string[]) => {
      for (const id of ids) stopFeed(id);
    },
    dispose: () => {
      for (const id of feeds.keys()) stopFeed(id);
    },
  };
}
