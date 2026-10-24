import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Transform, pipeline as pipe } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, clipboard, dialog, Menu, shell, type BrowserWindow } from "electron";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  FolderRelativePath,
  type FolderIdentity,
  type FolderWatchEvent,
} from "@irudd-scope/protocol/folder";
import { FolderError, STAGED_PREFIX, resolveInside } from "@irudd-scope/folder";
import { Uuid } from "../../workspace/contract.ts";
import type {
  FolderDropChoice,
  FolderDropClash,
  FolderDropPlan,
  FolderDropResult,
  FolderTransfer,
} from "./contract.ts";
import type { FolderSource } from "./source.ts";

/** Files one drop may copy, counting the files inside dropped folders. */
const MAX_DROP_FILES = 10_000;
/** A drop that is neither started nor discarded is forgotten after this long. */
const PLAN_LIFETIME_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 200;

const DropRequest = Schema.Struct({
  tabId: Uuid,
  target: FolderRelativePath,
  paths: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
  ),
});
const StartRequest = Schema.Struct({
  planId: Uuid,
  choices: Schema.Record(
    Schema.String.check(Schema.isPattern(/^\d{1,5}$/)),
    Schema.Literals(["replace", "keep"] satisfies FolderDropChoice[]),
  ),
});
const FileRequest = Schema.Struct({
  tabId: Uuid,
  path: FolderRelativePath.check(Schema.isMinLength(1)),
});
const MenuRequest = Schema.Struct({ ...FileRequest.fields, directory: Schema.Boolean });

/**
 * One dropped file, or one empty folder inside a dropped folder. `id` tells apart dropped
 * files that would land on the same name. `file` is the identity of the file the person
 * dropped; the copy reads only that file.
 */
type Identity = { dev: number; ino: number };
type DropItem = {
  id: string;
  source: string;
  path: string;
  size: number;
  file?: Identity;
};
type Plan = {
  tabId: string;
  items: DropItem[];
  /** IDs of items not written yet. */
  pending: Set<string>;
  written: string[];
  timer: ReturnType<typeof setTimeout>;
};
type Folder = { identity: FolderIdentity; source: FolderSource };

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The transfer did not finish.";

function lostConnection(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return error.name === "AbortError" || ["EPIPE", "ECONNRESET", "ECONNREFUSED"].includes(code);
}

function childPath(folder: string, name: string) {
  return folder ? `${folder}/${name}` : name;
}

/** `notes.md` becomes `notes 2.md`; a leading dot stays part of the name. */
export function keptName(path: string, count: number) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.indexOf(".", name.startsWith(".") ? 1 : 0);
  const kept = dot > 0 ? `${name.slice(0, dot)} ${count}${name.slice(dot)}` : `${name} ${count}`;
  return `${path.slice(0, slash + 1)}${kept}`;
}

const identity = ({ dev, ino }: Identity): Identity => ({ dev, ino });
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const changedSinceDrop = (source: string) =>
  new Error(`${basename(source)} changed after it was dropped. Drop it again.`);

/**
 * Reads the entries of a folder inside a drop, each with its own `lstat`, only while the
 * folder's path still leads to the folder first seen there, by device and inode, and not
 * through a link. Linux reads through the opened folder itself. Elsewhere the path is
 * checked again after reading, so a folder swapped for a link to another folder is refused.
 */
async function readDroppedFolder(source: string, expected: Identity) {
  const handle = await open(
    source,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: unknown) => {
    // A link, a file, or nothing at the path now; other errors, such as EACCES, stay as they are.
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (["ENOENT", "ENOTDIR", "ELOOP", "EMLINK"].includes(code)) throw changedSinceDrop(source);
    throw error;
  });
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !same(opened, expected)) throw changedSinceDrop(source);
    const linux = process.platform === "linux";
    const base = linux ? `/proc/self/fd/${handle.fd}` : source;
    // A dropped repository keeps its history out of the shared folder.
    const names = (await readdir(base)).filter((name) => name.toLowerCase() !== ".git");
    const entries = await Promise.all(
      names.map(async (name) => ({
        name,
        info: await lstat(join(base, name)).catch(() => undefined),
      })),
    );
    if (!linux) {
      const current = await lstat(source).catch(() => undefined);
      if (!current?.isDirectory() || !same(current, expected)) throw changedSinceDrop(source);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Lists what was dropped: each file, and every file and empty folder inside a dropped
 * folder. Links, special files, and `.git` inside dropped folders are skipped, so a drop
 * never copies something the person did not see. Each folder is read only while it is
 * still the one first seen at its path.
 */
async function dropItems(paths: readonly string[], target: string) {
  const items: DropItem[] = [];
  const add = (item: Omit<DropItem, "id">) => {
    if (items.length >= MAX_DROP_FILES)
      throw new Error(`Drop at most ${MAX_DROP_FILES.toLocaleString("en-US")} files at once.`);
    try {
      decode(FolderRelativePath, item.path);
    } catch {
      throw new Error(`Scope cannot copy ${item.path} because of the characters in its name.`);
    }
    items.push({ ...item, id: String(items.length) });
  };
  async function visit(source: string, path: string, expected: Identity) {
    const entries = await readDroppedFolder(source, expected);
    if (!entries.length) add({ source, path, size: 0 });
    for (const { name, info } of entries) {
      const child = join(source, name);
      const nested = `${path}/${name}`;
      if (info?.isDirectory()) await visit(child, nested, identity(info));
      else if (info?.isFile())
        add({ source: child, path: nested, size: info.size, file: identity(info) });
    }
  }
  for (const source of paths) {
    if (!source || !isAbsolute(source))
      throw new Error("Scope can copy only files and folders from this computer.");
    // The person chose this item, so a link they dropped is followed once, here.
    const info = await stat(source);
    const path = childPath(target, basename(source));
    if (info.isDirectory()) await visit(await realpath(source), path, identity(info));
    else if (info.isFile()) add({ source, path, size: info.size, file: identity(info) });
    else throw new Error(`${basename(source)} is not a file or folder.`);
  }
  return items;
}

/**
 * Opens a dropped file for reading only if its path still leads to the same file, by device
 * and inode, as when it was dropped. A path that now leads to a different file, through a
 * link or a folder above it, is refused; a link or hard link to the same file is the same
 * file and is read. Its bytes are not frozen: edits made since are copied. A FIFO swapped
 * in neither blocks nor is read.
 */
async function openDropped(item: DropItem) {
  const handle = await open(item.source, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(
    () => undefined,
  );
  const info = await handle?.stat();
  if (!handle || !info?.isFile() || info.dev !== item.file!.dev || info.ino !== item.file!.ino) {
    await handle?.close();
    throw new Error(`${basename(item.source)} changed after it was dropped. Drop it again.`);
  }
  return handle;
}

/** Target paths that already exist, read from each target folder's listing. */
async function existing(source: FolderSource, paths: readonly string[], signal: AbortSignal) {
  const byFolder = new Map<string, string[]>();
  for (const path of paths) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
  }
  const found = new Set<string>();
  for (const [folder, wanted] of byFolder) {
    const listing = await source.list(folder, true, signal).catch((error: unknown) => {
      if (error instanceof FolderError && error.code === "not-found") return undefined;
      throw error;
    });
    const names = new Set(listing?.entries.map((entry) => entry.path));
    for (const path of wanted) if (names.has(path)) found.add(path);
  }
  return found;
}

/** The first free `name N` for an item that keeps both. */
async function freeName(source: FolderSource, path: string, signal: AbortSignal) {
  const taken = await existing(
    source,
    Array.from({ length: 99 }, (_, index) => keptName(path, index + 2)),
    signal,
  );
  let count = 2;
  while (taken.has(keptName(path, count))) count++;
  return keptName(path, count);
}

/**
 * Drops into Folder tabs and saves out of them. Bytes stream between this computer and
 * the folder's machine; nothing is stored. Each transfer reports progress and can be
 * cancelled, and a cancelled or failed transfer leaves no partial file behind.
 */
export function registerFolderTransfers({
  handle,
  window,
  folder,
  notifyWatchers,
}: {
  handle: (channel: string, action: (input: unknown) => unknown) => void;
  window: BrowserWindow;
  folder: (tabId: string) => Promise<Folder>;
  notifyWatchers: (tabId: string, event: FolderWatchEvent) => void;
}) {
  const plans = new Map<string, Plan>();
  const running = new Map<string, { transfer: FolderTransfer; controller: AbortController }>();

  function report(transfer: FolderTransfer) {
    if (!window.isDestroyed()) window.webContents.send("scope:folder-transfer", transfer);
  }
  /** Runs one transfer with throttled progress and cancellation. */
  async function track<T>(
    transfer: Omit<FolderTransfer, "id" | "done" | "state">,
    run: (
      progress: (bytes: number) => void,
      signal: AbortSignal,
      size: (total: number) => void,
    ) => Promise<T>,
  ): Promise<{ value?: T; state: FolderTransfer["state"]; message?: string }> {
    const current: FolderTransfer = { ...transfer, id: randomUUID(), done: 0, state: "running" };
    const controller = new AbortController();
    running.set(current.id, { transfer: current, controller });
    let last = 0;
    report(current);
    try {
      const value = await run(
        (bytes) => {
          current.done += bytes;
          const now = performance.now();
          if (now - last < PROGRESS_INTERVAL_MS) return;
          last = now;
          report(current);
        },
        controller.signal,
        (total) => {
          current.total = total;
        },
      );
      report({ ...current, state: "done" });
      return { value, state: "done" };
    } catch (error) {
      const state = controller.signal.aborted ? "cancelled" : "failed";
      // An abort that is not the person's Cancel is a lost connection or a closing Scope.
      const text =
        state === "cancelled"
          ? undefined
          : lostConnection(error)
            ? "The connection to the folder's machine was lost."
            : message(error);
      report({ ...current, state, ...(text ? { message: text } : {}) });
      return { state, ...(text ? { message: text } : {}) };
    } finally {
      running.delete(current.id);
    }
  }
  const counted = (progress: (bytes: number) => void) =>
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        progress(chunk.byteLength);
        done(null, chunk);
      },
    });

  function finish(planId: string) {
    const plan = plans.get(planId);
    if (!plan) return;
    plans.delete(planId);
    clearTimeout(plan.timer);
    // One line per drop, listing every file it wrote, however many questions it took.
    if (plan.written.length)
      notifyWatchers(plan.tabId, { type: "dropped", paths: [...plan.written] });
  }

  handle("scope:folder-drop-prepare", async (input): Promise<FolderDropPlan> => {
    const request = decode(DropRequest, input);
    try {
      const { source } = await folder(request.tabId);
      const items = await dropItems(request.paths, request.target);
      const found = await existing(
        source,
        items.map((item) => item.path),
        AbortSignal.timeout(60_000),
      );
      // A second dropped file with the same name as an earlier one clashes with it too.
      const seen = new Set<string>();
      const clashes: FolderDropClash[] = [];
      for (const item of items) {
        if (found.has(item.path) || seen.has(item.path))
          clashes.push({ id: item.id, path: item.path });
        seen.add(item.path);
      }
      const planId = randomUUID();
      plans.set(planId, {
        tabId: request.tabId,
        items,
        pending: new Set(items.map((item) => item.id)),
        written: [],
        timer: setTimeout(() => finish(planId), PLAN_LIFETIME_MS).unref(),
      });
      return {
        status: "ok",
        planId,
        files: items.filter((item) => item.file).length,
        bytes: items.reduce((total, item) => total + item.size, 0),
        clashes,
      };
    } catch (error) {
      return { status: "failed", message: message(error) };
    }
  });

  /** Copies one item to `path`; without `replace` an existing name fails with `exists`. */
  async function copyItem(
    source: FolderSource,
    item: DropItem,
    path: string,
    replace: boolean,
    progress: (bytes: number) => void,
    signal: AbortSignal,
  ) {
    if (!item.file) {
      await source.createDirectory(path, replace, signal);
      return path;
    }
    const handle = await openDropped(item);
    const body = pipe(handle.createReadStream(), counted(progress), () => {});
    try {
      return (await source.write(path, body, replace, signal)).path;
    } finally {
      // Destroying the body ends the read stream, which closes the file.
      body.destroy();
    }
  }

  handle("scope:folder-drop-start", async (input): Promise<FolderDropResult> => {
    const request = decode(StartRequest, input);
    const plan = plans.get(request.planId);
    if (!plan) throw new Error("This drop is no longer available. Drop the files again.");
    const { source } = await folder(plan.tabId);
    const items = plan.items.filter((item) => plan.pending.has(item.id));
    const written: string[] = [];
    const directories: string[] = [];
    const clashes: FolderDropClash[] = [];
    const run = await track(
      {
        tabId: plan.tabId,
        kind: "drop",
        name:
          items.length === 1
            ? basename(items[0]!.path)
            : `${items.filter((item) => item.file).length} files`,
        total: items.reduce((total, item) => total + item.size, 0),
      },
      async (progress, signal) => {
        for (const item of items) {
          signal.throwIfAborted();
          const choice = request.choices[item.id];
          try {
            const target =
              choice === "keep" ? await freeName(source, item.path, signal) : item.path;
            const path = await copyItem(
              source,
              item,
              target,
              choice === "replace",
              progress,
              signal,
            );
            written.push(path);
            if (!item.file) directories.push(path);
          } catch (error) {
            // The name exists, for example because it appeared during the copy: ask again.
            if (error instanceof FolderError && error.code === "exists") {
              clashes.push({ id: item.id, path: item.path });
              continue;
            }
            throw error;
          }
          plan.pending.delete(item.id);
        }
      },
    );
    plan.written.push(...written);
    const result: FolderDropResult = {
      written,
      directories,
      clashes,
      cancelled: run.state === "cancelled",
      ...(run.message ? { failed: run.message } : {}),
    };
    if (!clashes.length || run.state !== "done") finish(request.planId);
    return result;
  });
  handle("scope:folder-drop-discard", (input) => finish(decode(Uuid, input)));

  async function save(tabId: string, path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const selection = await dialog.showSaveDialog(window, {
      title: "Save to computer",
      defaultPath: join(app.getPath("downloads"), name),
    });
    if (selection.canceled || !selection.filePath) return false;
    const destination = selection.filePath;
    const staged = join(dirname(destination), `${STAGED_PREFIX}${randomUUID()}`);
    const { source } = await folder(tabId);
    const result = await track(
      { tabId, kind: "save", name, total: 0 },
      async (progress, signal, total) => {
        const file = await source.download(path, signal);
        total(file.size);
        let size = 0;
        try {
          await pipeline(
            file.stream,
            counted((bytes) => {
              size += bytes;
              progress(bytes);
            }),
            createWriteStream(staged, { flags: "wx", flush: true }),
            { signal },
          );
          if (Number.isFinite(file.size) && size !== file.size)
            throw new Error(`${name} changed while it was saved. Save it again.`);
          await rename(staged, destination);
        } catch (error) {
          await unlink(staged).catch(() => {});
          throw error;
        }
      },
    );
    if (result.state === "failed") throw new Error(result.message);
    return result.state === "done";
  }
  handle("scope:folder-save", (input) => {
    const request = decode(FileRequest, input);
    return save(request.tabId, request.path);
  });
  handle("scope:folder-transfer-cancel", (input) => {
    running.get(decode(Uuid, input))?.controller.abort();
  });

  /** The file's absolute path on its machine, using that machine's separator. */
  function absolute(identity: FolderIdentity, path: string) {
    const separator = identity.path.includes("\\") && !identity.path.includes("/") ? "\\" : "/";
    if (identity.machineId === "local") return join(identity.path, ...path.split("/"));
    return `${identity.path.replace(/[\\/]$/, "")}${separator}${path.split("/").join(separator)}`;
  }
  handle("scope:folder-file-menu", async (input) => {
    const request = decode(MenuRequest, input);
    const { identity } = await folder(request.tabId);
    const local = identity.machineId === "local";
    const failed = (error: unknown) =>
      report({
        id: randomUUID(),
        tabId: request.tabId,
        kind: "save",
        name: request.path.slice(request.path.lastIndexOf("/") + 1),
        done: 0,
        total: 0,
        state: "failed",
        message: message(error),
      });
    Menu.buildFromTemplate([
      ...(request.directory
        ? []
        : [
            {
              label: "Save to computer…",
              click: () => void save(request.tabId, request.path).catch(failed),
            },
          ]),
      { label: "Copy path", click: () => clipboard.writeText(absolute(identity, request.path)) },
      ...(local
        ? [
            {
              label: process.platform === "win32" ? "Show in Explorer" : "Reveal in Finder",
              click: () =>
                void resolveInside(identity.path, request.path)
                  .then((real) => lstat(real).then(() => shell.showItemInFolder(real)))
                  .catch(failed),
            },
          ]
        : []),
    ]).popup({ window });
  });

  return {
    /** Cancels the transfers and forgets the drops of tabs that closed. */
    cancelTabs(ids: readonly string[]) {
      for (const { transfer, controller } of running.values())
        if (ids.includes(transfer.tabId)) controller.abort();
      for (const [planId, plan] of plans) if (ids.includes(plan.tabId)) finish(planId);
    },
    dispose() {
      for (const { controller } of running.values()) controller.abort();
    },
  };
}
