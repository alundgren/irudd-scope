import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  MAX_FOLDER_CHANGES,
  type FolderChange,
  type FolderFeedEvent,
} from "@irudd-scope/protocol/folder";
import { GIT_DIRECTORY, IgnoreFilter } from "./ignore-rules.ts";
import { checkRoot } from "./paths.ts";
import { walkDirectories } from "./walk.ts";

export type FolderWatch = { close: () => void };
export type FolderWatchOptions = {
  /** How often to look for added and removed files when live watching is unavailable. */
  pollMs?: number;
  /** How often to check that the folder still exists. */
  rootCheckMs?: number;
  /** Skip native watching, for machines that have run out of file watches. */
  polling?: boolean;
};

const BATCH_MS = 100;
const MAX_BATCH_MS = 400;

function exhausted(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EMFILE", "ENFILE", "ENOSPC"].includes(String(error.code))
  );
}

/**
 * Reports changes in a folder as grouped batches. macOS and Windows use one recursive
 * native watch. Linux watches each directory that is not ignored. When watches run out,
 * the folder is polled and `status.live` becomes false.
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
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, "rename" | "change">();
  private overflow = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private firstPending = 0;
  private rootTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot = new Map<string, Set<string>>();
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
    for (const watcher of this.watchers.values()) watcher.close();
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
    void this.startPolling(this.generation);
  }

  private watchRecursively() {
    const watcher = watch(this.root, { recursive: true }, (type, name) => {
      if (name === null) this.overflow = true;
      else this.record(String(name).split(sep).join("/"), type);
      this.schedule();
    });
    const generation = this.generation;
    watcher.on("error", () => this.fallBack(generation));
    this.watchers.set("", watcher);
  }

  private async watchDirectories(start: string, generation: number) {
    await walkDirectories(
      this.root,
      ({ path }) => {
        if (generation !== this.generation || this.watchers.has(path)) return;
        const absolute = path ? join(this.root, ...path.split("/")) : this.root;
        const watcher = watch(absolute, (type, name) => {
          if (name === null) this.overflow = true;
          else this.record(path ? `${path}/${name}` : String(name), type);
          this.schedule();
        });
        watcher.on("error", (error) => {
          watcher.close();
          this.watchers.delete(path);
          if (exhausted(error)) this.fallBack(generation);
        });
        this.watchers.set(path, watcher);
      },
      { start },
    );
  }

  private record(path: string, type: "rename" | "change") {
    if (path === GIT_DIRECTORY || path.startsWith(`${GIT_DIRECTORY}/`)) {
      if (path === `${GIT_DIRECTORY}/info/exclude`) this.filter.clear();
      return;
    }
    if (path.endsWith(".gitignore")) this.filter.clear();
    this.pending.set(path, this.pending.get(path) === "rename" ? "rename" : type);
  }

  private schedule() {
    if (!this.pending.size && !this.overflow) return;
    const now = Date.now();
    if (this.flushTimer === undefined) this.firstPending = now;
    clearTimeout(this.flushTimer);
    const wait = Math.max(0, Math.min(BATCH_MS, this.firstPending + MAX_BATCH_MS - now));
    this.flushTimer = setTimeout(() => void this.flush(), wait);
  }

  private async flush() {
    this.flushTimer = undefined;
    const generation = this.generation;
    const paths = [...this.pending];
    this.pending.clear();
    let overflow = this.overflow || paths.length > MAX_FOLDER_CHANGES;
    this.overflow = false;
    const changes: FolderChange[] = [];
    if (!overflow)
      for (const [path, type] of paths) {
        const info = await lstat(join(this.root, ...path.split("/"))).catch(() => undefined);
        if (await this.filter.ignores(path, info?.isDirectory() ?? false)) continue;
        changes.push({ path, type: !info ? "deleted" : type === "rename" ? "created" : "changed" });
        if (info?.isDirectory() && process.platform === "linux" && this.live)
          await this.watchDirectories(path, generation).catch((error: unknown) => {
            if (exhausted(error)) this.fallBack(generation);
          });
      }
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

  private async scan() {
    const snapshot = new Map<string, Set<string>>();
    await walkDirectories(this.root, ({ path, files, directories }) => {
      snapshot.set(path, new Set([...files, ...directories.map((name) => `${name}/`)]));
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

function diffSnapshots(before: Map<string, Set<string>>, after: Map<string, Set<string>>) {
  const changes: FolderChange[] = [];
  const join = (directory: string, name: string) =>
    (directory ? `${directory}/${name}` : name).replace(/\/$/, "");
  for (const [directory, names] of after) {
    const previous = before.get(directory);
    if (!previous) continue;
    for (const name of names)
      if (!previous.has(name)) changes.push({ type: "created", path: join(directory, name) });
    for (const name of previous)
      if (!names.has(name)) changes.push({ type: "deleted", path: join(directory, name) });
  }
  return changes;
}
