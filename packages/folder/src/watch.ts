import { watch, type FSWatcher, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  MAX_FOLDER_CHANGES,
  type FolderChange,
  type FolderFeedEvent,
} from "@irudd-scope/protocol/folder";
import { IgnoreFilter } from "./ignore-rules.ts";
import { GIT_DIRECTORY, checkRoot, gitName, hiddenName, sameSpelling } from "./paths.ts";
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

function parent(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** The directory whose ignore rules a changed path sets, when the path is a `.gitignore`. */
function rulesDirectory(path: string): string | undefined {
  return sameSpelling(path.slice(path.lastIndexOf("/") + 1), ".gitignore")
    ? parent(path)
    : undefined;
}

/**
 * The fewest directories that cover every given one: `a` covers `a/b`. More than a batch
 * can list become the whole folder.
 */
function outermost(directories: Iterable<string>): string[] {
  const sorted = [...new Set(directories)].sort();
  const kept: string[] = [];
  for (const directory of sorted)
    if (!kept.some((above) => within(directory, above))) kept.push(directory);
  return kept.length > MAX_FOLDER_CHANGES ? [""] : kept;
}

const EXCLUDE = `${GIT_DIRECTORY}/info/exclude`;

/**
 * Reports changes in a folder as grouped batches. macOS and Windows use one recursive
 * native watch. Linux watches each directory that is not ignored. When watches run out,
 * the folder is polled and `status.live` becomes false. Ignored paths are dropped before
 * a batch is counted, so activity in ignored folders never causes an overflow.
 *
 * A changed `.gitignore` or `.git/info/exclude` is reported in `ignoreRulesChanged`, so
 * readers reload what they show below it; on Linux the directory watches below it are
 * matched to the new rules. Nothing else inside `.git` is reported.
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
  /** Linux watches on `.git` and `.git/info`, used only to notice `.git/info/exclude` changing. */
  private readonly excludeWatchers = new Map<string, Watched>();
  private readonly pending = new Map<string, "rename" | "change">();
  private readonly rulesChanged = new Set<string>();
  /**
   * Native watches name an event on a watched folder itself, such as a change to its
   * permissions, by the folder's own name, as if it were a child: `app` for the folder
   * `/work/app`, `docs/docs` for `docs` on Linux. Keyed by that path, whether an entry with
   * that name really exists, so only a real one is reported as deleted.
   */
  private readonly namesakes = new Map<string, boolean>();
  /** The top-level `.git` folder and its exclude file as last seen, by identity, size, and time. */
  private gitSeen: string | undefined;
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
    for (const { watcher } of [...this.watchers.values(), ...this.excludeWatchers.values()])
      watcher.close();
    this.watchers.clear();
    this.excludeWatchers.clear();
    this.namesakes.clear();
    clearTimeout(this.pollTimer);
    this.snapshot.clear();
  }

  private async startWatching() {
    const generation = this.generation;
    if (!this.live) return this.startPolling(generation);
    this.gitSeen = await this.gitState();
    try {
      if (process.platform === "linux") {
        await this.watchDirectories("", generation);
        await this.watchExclude(generation);
      } else {
        this.watchRecursively();
        await this.noteNamesake("");
      }
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
    await this.noteNamesake(path);
  }

  private async noteNamesake(directory: string) {
    const name = directory ? directory.slice(directory.lastIndexOf("/") + 1) : basename(this.root);
    if (!name) return;
    const path = directory ? `${directory}/${name}` : name;
    const info = await lstat(join(this.root, ...path.split("/"))).catch(() => undefined);
    this.namesakes.set(path, Boolean(info));
  }

  private async watchDirectories(start: string, generation: number) {
    await walkDirectories(this.root, ({ path }) => this.watchDirectory(path, generation), {
      start,
    });
  }

  /**
   * Linux watches no directory inside `.git`, so `.git` and `.git/info` get watches of their
   * own that only notice `info` and `exclude` changing. Neither reports anything else.
   */
  private async watchExclude(generation: number) {
    await this.watchGitDirectory(GIT_DIRECTORY, "info", generation);
    await this.watchGitDirectory(`${GIT_DIRECTORY}/info`, "exclude", generation);
  }

  private async watchGitDirectory(path: string, name: string, generation: number) {
    // Each folder on the way must be a real directory, so a link never adds a watch elsewhere.
    let info: Stats | undefined;
    let current = this.root;
    for (const part of path.split("/")) {
      current = join(current, part);
      info = await lstat(current).catch(() => undefined);
      if (!info?.isDirectory()) break;
    }
    const existing = this.excludeWatchers.get(path);
    if (generation !== this.generation || this.closed) return;
    if (!info?.isDirectory()) {
      existing?.watcher.close();
      this.excludeWatchers.delete(path);
      return;
    }
    if (existing?.ino === info.ino) return;
    existing?.watcher.close();
    const watcher = watch(current, (_type, changed) => {
      if (changed !== null && String(changed) !== name) return;
      if (name === "info")
        void this.watchGitDirectory(`${GIT_DIRECTORY}/info`, "exclude", generation).catch(() => {});
      this.excludeChanged();
    });
    watcher.on("error", () => {
      watcher.close();
      if (this.excludeWatchers.get(path)?.watcher === watcher) this.excludeWatchers.delete(path);
    });
    this.excludeWatchers.set(path, { watcher, ino: info.ino });
  }

  private async gitState() {
    const git = await lstat(join(this.root, GIT_DIRECTORY)).catch(() => undefined);
    return `${git?.isDirectory() ? git.ino : ""}:${await this.excludeSignature()}`;
  }

  /**
   * `.git` itself was created, removed, moved, or replaced, which can bring other exclude
   * rules or none. Linux moves its `.git` watches to the folder now there.
   */
  private async checkGit() {
    const generation = this.generation;
    const state = await this.gitState();
    if (generation !== this.generation || state === this.gitSeen) return;
    this.gitSeen = state;
    if (process.platform === "linux" && this.live) await this.watchExclude(generation);
    this.excludeChanged();
  }

  private excludeChanged() {
    this.filter.clear();
    this.rulesChanged.add("");
    this.schedule();
  }

  /** Stops watching a directory that was removed or replaced, and everything below it. */
  private unwatch(directory: string) {
    for (const [path, { watcher }] of this.watchers)
      if (path && within(path, directory)) {
        watcher.close();
        this.watchers.delete(path);
      }
    for (const path of this.namesakes.keys())
      if (parent(path) && within(parent(path), directory)) this.namesakes.delete(path);
  }

  /**
   * Makes Linux watches at and below `start` match the folder, after more changes than can
   * be listed or after ignore rules changed: removed, replaced, and newly ignored directories
   * lose their watches, and new or newly shown directories gain one.
   */
  private async reconcileWatches(generation: number, start = "") {
    const found = new Set<string>();
    await walkDirectories(
      this.root,
      async ({ path }) => {
        found.add(path);
        await this.watchDirectory(path, generation);
      },
      { start },
    );
    for (const path of this.watchers.keys())
      if (within(path, start) && !found.has(path)) this.unwatch(path);
  }

  private record(path: string, type: "rename" | "change") {
    const parts = path.split("/");
    if (gitName(parts[0]!)) {
      const inGit = parts.slice(1).join("/");
      // macOS and Windows see inside `.git` through the recursive watch.
      if (sameSpelling(inGit, "info") || sameSpelling(inGit, "info/exclude")) this.excludeChanged();
      else if (!inGit) void this.checkGit().catch(() => {});
      return;
    }
    if (parts.some(hiddenName)) return;
    const rules = rulesDirectory(path);
    if (rules !== undefined) {
      this.filter.clear();
      this.rulesChanged.add(rules);
    }
    if (this.pending.size >= MAX_CLASSIFIED) this.overflow = true;
    else this.pending.set(path, this.pending.get(path) === "rename" ? "rename" : type);
  }

  private schedule() {
    if (!this.pending.size && !this.overflow && !this.rulesChanged.size) return;
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
    const existed = this.namesakes.get(path);
    if (existed !== undefined) {
      this.namesakes.set(path, Boolean(info));
      // An event on the watched folder itself, not a child that was there.
      if (!info && !existed) return undefined;
    }
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
    const rulesChanged = outermost(this.rulesChanged);
    this.rulesChanged.clear();
    let overflow = this.overflow;
    this.overflow = false;
    const changes: FolderChange[] = [];
    const linux = process.platform === "linux" && this.live;
    // A folder created, removed, or moved in or out brings its own ignore files, which have
    // no events of their own, so cached rules at and below it are read again.
    if (overflow) this.filter.clear();
    else this.filter.forget(paths.filter(([, type]) => type === "rename").map(([path]) => path));
    if (!overflow)
      for (const [path, type] of paths) {
        const result = await this.classify(path, type);
        if (!result) continue;
        changes.push(result.change);
        if (!linux) continue;
        if (result.change.type === "deleted") this.unwatch(path);
        else if (result.directory) await this.watchSubtree(path, generation);
      }
    if (linux)
      for (const start of overflow ? [""] : rulesChanged) {
        if (generation !== this.generation) break;
        await this.reconcileWatches(generation, start).catch((error: unknown) => {
          // Out of watches while catching up: check by polling and say so, as on startup.
          if (exhausted(error)) this.fallBack(generation);
          else console.error("Scope could not update a folder's watches.");
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
    if (overflow || changes.length || rulesChanged.length)
      this.emit({
        type: "changes",
        changes: overflow ? [] : changes,
        overflow,
        ...(rulesChanged.length ? { ignoreRulesChanged: rulesChanged } : {}),
      });
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

  /** Changes to `.git/info/exclude` when polling; its contents are never read here. */
  private async excludeSignature() {
    const info = await lstat(join(this.root, ...EXCLUDE.split("/"))).catch(() => undefined);
    return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : "";
  }

  private async startPolling(generation: number) {
    this.snapshot = await this.scan();
    let exclude = await this.excludeSignature();
    const poll = async () => {
      if (generation !== this.generation || this.closed) return;
      const next = await this.scan();
      const nextExclude = await this.excludeSignature();
      if (generation !== this.generation || this.closed) return;
      const changes = diffSnapshots(this.snapshot, next);
      this.snapshot = next;
      const rules = changes.flatMap((change) =>
        change.type === "renamed" ? [] : (rulesDirectory(change.path) ?? []),
      );
      if (nextExclude !== exclude) rules.push("");
      exclude = nextExclude;
      const rulesChanged = outermost(rules);
      if (changes.length || rulesChanged.length)
        this.emit({
          type: "changes",
          ...(changes.length > MAX_FOLDER_CHANGES
            ? { changes: [], overflow: true }
            : { changes, overflow: false }),
          ...(rulesChanged.length ? { ignoreRulesChanged: rulesChanged } : {}),
        });
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
