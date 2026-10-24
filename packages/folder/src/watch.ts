import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  MAX_FOLDER_CHANGES,
  type FolderChange,
  type FolderFeedEvent,
} from "@irudd-scope/protocol/folder";
import { IgnoreFilter } from "./ignore-rules.ts";
import { checkRoot, gitName, hiddenName } from "./paths.ts";
import { walkDirectories } from "./walk.ts";

export type FolderWatch = { close: () => void };
export type FolderWatchOptions = {
  /** How often to look for added, removed, and edited files when live watching is unavailable. */
  pollMs?: number;
  /** How often to check that the folder still exists. */
  rootCheckMs?: number;
  /** Skip native watching, for machines that have run out of file watches. */
  polling?: boolean;
};

const BATCH_MS = 100;
const MAX_BATCH_MS = 400;
// Above this many raw events in one batch, paths are not classified one by one.
const MAX_CLASSIFIED = 20_000;

type Watched = { watcher: FSWatcher; ino: number };
type Snapshot = Map<string, Map<string, string>>;

function exhausted(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EMFILE", "ENFILE", "ENOSPC"].includes(String(error.code))
  );
}

function within(path: string, directory: string) {
  return !directory || path === directory || path.startsWith(`${directory}/`);
}

/**
 * Reports changes in a folder as grouped batches. macOS and Windows use one recursive
 * native watch. Linux watches each directory that is not ignored. When watches run out,
 * the folder is polled and `status.live` becomes false. Ignored paths are dropped before
 * a batch is counted, so activity in ignored folders never causes an overflow.
 */
export function watchFolder(
  root: string,
  onEvent: (event: FolderFeedEvent) => void,
  options: FolderWatchOptions = {},
): FolderWatch {
  return new FolderWatcher(root, onEvent, options).start();
}

class FolderWatcher {
  private closed = false;
  private exists: boolean | undefined;
  private live: boolean;
  private readonly watchers = new Map<string, Watched>();
  private readonly pending = new Map<string, "rename" | "change">();
  private overflow = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private firstPending = 0;
  private rootTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: Snapshot = new Map();
  private generation = 0;
  private readonly filter: IgnoreFilter;
  private readonly root: string;
  private readonly onEvent: (event: FolderFeedEvent) => void;
  private readonly options: FolderWatchOptions;

  constructor(
    root: string,
    onEvent: (event: FolderFeedEvent) => void,
    options: FolderWatchOptions,
  ) {
    this.root = root;
    this.onEvent = onEvent;
    this.options = options;
    this.filter = new IgnoreFilter(root);
    this.live = !options.polling;
  }

  start(): FolderWatch {
    void this.checkRoot();
    this.rootTimer = setInterval(() => void this.checkRoot(), this.options.rootCheckMs ?? 2000);
    return { close: () => this.close() };
  }

  private emit(event: FolderFeedEvent) {
    if (!this.closed) this.onEvent(event);
  }

  private async checkRoot() {
    const exists = await checkRoot(this.root).then(
      () => true,
      () => false,
    );
    if (this.closed || exists === this.exists) return;
    const returned = this.exists === false;
    this.exists = exists;
    this.stopWatching();
    if (exists) await this.startWatching();
    this.emit({ type: "status", exists, live: this.live });
    // A folder that comes back may have different contents; readers reload what they show.
    if (exists && returned) this.emit({ type: "changes", changes: [], overflow: true });
  }

  private stopWatching() {
    this.generation++;
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    clearTimeout(this.pollTimer);
    this.snapshot.clear();
  }

  private async startWatching() {
    const generation = this.generation;
    if (!this.live) return this.startPolling(generation);
    try {
      if (process.platform === "linux") await this.watchDirectories("", generation);
      else this.watchRecursively();
    } catch (error) {
      if (!exhausted(error)) console.error("Scope could not watch a folder; checking it instead.");
      this.fallBack(generation);
    }
  }

  private fallBack(generation: number) {
    if (generation !== this.generation || this.closed) return;
    this.stopWatching();
    this.live = false;
    this.emit({ type: "status", exists: this.exists ?? false, live: false });
    const polling = this.generation;
    // Changes that triggered the switch are already in the polling baseline; readers reload.
    void this.startPolling(polling).then(() => {
      if (polling === this.generation) this.emit({ type: "changes", changes: [], overflow: true });
    });
  }

  private watchRecursively() {
    const watcher = watch(this.root, { recursive: true }, (type, name) => {
      if (name === null) this.overflow = true;
      else this.record(String(name).split(sep).join("/"), type);
      this.schedule();
    });
    const generation = this.generation;
    watcher.on("error", () => this.fallBack(generation));
    this.watchers.set("", { watcher, ino: 0 });
  }

  /** Watches one directory of the folder on Linux, replacing a watch on an older directory. */
  private async watchDirectory(path: string, generation: number) {
    const absolute = path ? join(this.root, ...path.split("/")) : this.root;
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isDirectory() || generation !== this.generation) return;
    const existing = this.watchers.get(path);
    if (existing?.ino === info.ino) return;
    existing?.watcher.close();
    const watcher = watch(absolute, (type, name) => {
      if (name === null) this.overflow = true;
      else this.record(path ? `${path}/${name}` : String(name), type);
      this.schedule();
    });
    watcher.on("error", (error) => {
      watcher.close();
      if (this.watchers.get(path)?.watcher === watcher) this.watchers.delete(path);
      if (exhausted(error)) this.fallBack(generation);
    });
    this.watchers.set(path, { watcher, ino: info.ino });
  }

  private async watchDirectories(start: string, generation: number) {
    await walkDirectories(this.root, ({ path }) => this.watchDirectory(path, generation), {
      start,
    });
  }

  /** Stops watching a directory that was removed or replaced, and everything below it. */
  private unwatch(directory: string) {
    for (const [path, { watcher }] of this.watchers)
      if (path && within(path, directory)) {
        watcher.close();
        this.watchers.delete(path);
      }
  }

  /**
   * Makes Linux watches match the folder after more changes than can be listed: removed or
   * replaced directories lose their watches and new directories gain one.
   */
  private async reconcileWatches(generation: number) {
    const found = new Set<string>();
    await walkDirectories(this.root, async ({ path }) => {
      found.add(path);
      await this.watchDirectory(path, generation);
    });
    for (const path of this.watchers.keys()) if (!found.has(path)) this.unwatch(path);
  }

  private record(path: string, type: "rename" | "change") {
    const parts = path.split("/");
    if (gitName(parts[0]!)) {
      if (parts.slice(1).join("/") === "info/exclude") this.filter.clear();
      return;
    }
    if (parts.some(hiddenName)) return;
    if (path.endsWith(".gitignore")) this.filter.clear();
    if (this.pending.size >= MAX_CLASSIFIED) this.overflow = true;
    else this.pending.set(path, this.pending.get(path) === "rename" ? "rename" : type);
  }

  private schedule() {
    if (!this.pending.size && !this.overflow) return;
    const now = Date.now();
    if (this.flushTimer === undefined) this.firstPending = now;
    clearTimeout(this.flushTimer);
    const wait = Math.max(0, Math.min(BATCH_MS, this.firstPending + MAX_BATCH_MS - now));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushing = this.flushing.then(() => this.flush()).catch(() => {});
    }, wait);
  }

  private async classify(path: string, type: "rename" | "change") {
    const info = await lstat(join(this.root, ...path.split("/"))).catch(() => undefined);
    const ignored = info
      ? await this.filter.ignores(path, info.isDirectory())
      : (await this.filter.ignores(path, false)) || (await this.filter.ignores(path, true));
    if (ignored) return undefined;
    const change: FolderChange = {
      path,
      type: !info ? "deleted" : type === "rename" ? "created" : "changed",
    };
    return { change, directory: info?.isDirectory() ?? false };
  }

  private async flush() {
    const generation = this.generation;
    const paths = [...this.pending];
    this.pending.clear();
    let overflow = this.overflow;
    this.overflow = false;
    const changes: FolderChange[] = [];
    const linux = process.platform === "linux" && this.live;
    if (!overflow)
      for (const [path, type] of paths) {
        const result = await this.classify(path, type);
        if (!result) continue;
        changes.push(result.change);
        if (!linux) continue;
        if (result.change.type === "deleted") this.unwatch(path);
        else if (result.directory) await this.watchSubtree(path, generation);
      }
    if (overflow && linux)
      await this.reconcileWatches(generation).catch((error: unknown) => {
        // Out of watches while catching up: check by polling and say so, as on startup.
        if (exhausted(error)) this.fallBack(generation);
        else console.error("Scope could not update a folder's watches.");
      });
    if (generation !== this.generation) return;
    // Removing the folder itself is reported by the root check, not as a change inside it.
    if (
      !(await checkRoot(this.root).then(
        () => true,
        () => false,
      ))
    )
      return;
    if (changes.length > MAX_FOLDER_CHANGES) overflow = true;
    if (overflow || changes.length)
      this.emit({ type: "changes", changes: overflow ? [] : changes, overflow });
  }

  /** Watches a new or replaced directory and the directories inside it. */
  private async watchSubtree(path: string, generation: number) {
    const info = await lstat(join(this.root, ...path.split("/"))).catch(() => undefined);
    if (this.watchers.get(path)?.ino === info?.ino) return;
    this.unwatch(path);
    await this.watchDirectories(path, generation).catch((error: unknown) => {
      if (exhausted(error)) this.fallBack(generation);
    });
  }

  private async startPolling(generation: number) {
    this.snapshot = await this.scan();
    const poll = async () => {
      if (generation !== this.generation || this.closed) return;
      const next = await this.scan();
      if (generation !== this.generation || this.closed) return;
      const changes = diffSnapshots(this.snapshot, next);
      this.snapshot = next;
      if (changes.length)
        this.emit(
          changes.length > MAX_FOLDER_CHANGES
            ? { type: "changes", changes: [], overflow: true }
            : { type: "changes", changes, overflow: false },
        );
      this.pollTimer = setTimeout(() => void poll(), this.options.pollMs ?? 3000);
    };
    this.pollTimer = setTimeout(() => void poll(), this.options.pollMs ?? 3000);
  }

  /** Every directory that is not ignored, with each file's size and modified time. */
  private async scan(): Promise<Snapshot> {
    const snapshot: Snapshot = new Map();
    await walkDirectories(this.root, async ({ path, files, directories }) => {
      const entries = new Map(directories.map((name) => [`${name}/`, ""]));
      for (let index = 0; index < files.length; index += 256)
        await Promise.all(
          files.slice(index, index + 256).map(async (name) => {
            const info = await lstat(join(this.root, ...path.split("/"), name)).catch(
              () => undefined,
            );
            if (info) entries.set(name, `${info.size}:${info.mtimeMs}`);
          }),
        );
      snapshot.set(path, entries);
    });
    return snapshot;
  }

  private close() {
    this.closed = true;
    clearInterval(this.rootTimer);
    clearTimeout(this.flushTimer);
    this.stopWatching();
  }
}

function diffSnapshots(before: Snapshot, after: Snapshot) {
  const changes: FolderChange[] = [];
  const join = (directory: string, name: string) =>
    (directory ? `${directory}/${name}` : name).replace(/\/$/, "");
  for (const [directory, names] of after) {
    const previous = before.get(directory);
    if (!previous) continue;
    for (const [name, signature] of names) {
      const old = previous.get(name);
      if (old === undefined) changes.push({ type: "created", path: join(directory, name) });
      else if (old !== signature) changes.push({ type: "changed", path: join(directory, name) });
    }
    for (const name of previous.keys())
      if (!names.has(name)) changes.push({ type: "deleted", path: join(directory, name) });
  }
  return changes;
}
