import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  MAX_FOLDER_NAME_MATCHES,
  type FolderChange,
  type FolderFeedEvent,
} from "@irudd-scope/protocol/folder";
import { FolderError } from "@irudd-scope/folder";
import { Uuid } from "../../workspace/contract.ts";
import type { MainPluginContext } from "../main-api.ts";
import type {
  FolderFilterResult,
  FolderListResult,
  FolderNameMatch,
  FolderSearchResult,
  FolderViewEvent,
} from "./contract.ts";
import type { FolderDirectory, FolderSource } from "./source.ts";

/** Above this many paths the filter asks the folder's machine instead of keeping a list. */
export const MAX_FOLDER_PATHS = 200_000;
/** In machine mode, changes ask an open filter again at most this often. */
const MACHINE_FILTER_REFRESH_MS = 1000;

const FilterRequest = Schema.Struct({
  tabId: Uuid,
  text: Schema.String.check(Schema.isMaxLength(1024)),
  showIgnored: Schema.Boolean,
});
const SearchRequest = Schema.Struct({
  tabId: Uuid,
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  showIgnored: Schema.Boolean,
});

type PathEntry = { directory: boolean; ignored: boolean; lower: string };
type Unavailable = (error: unknown, root: boolean) => Exclude<FolderListResult, { status: "ok" }>;

function parent(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
const under = (path: string, directory: string) =>
  !directory || path === directory || path.startsWith(`${directory}/`);

/**
 * Every path in one folder, in memory only, built by a background walk and kept current
 * from the change feed. A created directory is walked, because its files may have no
 * change events of their own. When the list would pass 200,000 paths or a directory has
 * too many entries to list completely, it is dropped and the folder's machine matches
 * names instead.
 */
class FolderPaths {
  readonly showIgnored: boolean;
  private readonly source: FolderSource;
  private readonly onUpdate: () => void;
  private readonly controller = new AbortController();
  private readonly walking = new AbortController();
  private paths = new Map<string, PathEntry>();
  state: "scanning" | "ready" | "machine" | "failed" = "scanning";
  private updates = Promise.resolve();
  private nameSearch: AbortController | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(source: FolderSource, showIgnored: boolean, onUpdate: () => void) {
    this.source = source;
    this.showIgnored = showIgnored;
    this.onUpdate = onUpdate;
    void this.walk("", false).then(
      () => this.finish(),
      () => this.finish(true),
    );
  }

  private finish(failed = false) {
    if (this.controller.signal.aborted || this.state === "machine") return;
    if (this.state === "scanning") this.state = failed ? "failed" : "ready";
    this.onUpdate();
  }

  private toMachine() {
    if (this.state === "machine") return;
    this.state = "machine";
    this.paths = new Map();
    // Stops the walk; name searches use their own signal.
    this.walking.abort();
    this.onUpdate();
  }

  /** Adds one path, unless the list is too long to keep. Returns false in machine mode. */
  private insert(path: string, directory: boolean, ignored: boolean): boolean {
    if (this.state === "machine") return false;
    this.paths.set(path, { directory, ignored, lower: path.toLowerCase() });
    if (this.paths.size <= MAX_FOLDER_PATHS) return true;
    this.toMachine();
    return false;
  }

  private add(directory: FolderDirectory, ignoredAbove: boolean) {
    if (directory.truncated) return this.toMachine();
    for (const entry of directory.entries) {
      const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
      if (!this.insert(path, entry.directory, ignoredAbove || entry.ignored)) return;
    }
  }

  private walk(start: string, ignoredAbove: boolean) {
    let last = Date.now();
    return this.source.walk(
      start,
      this.showIgnored,
      (directory) => {
        this.add(directory, ignoredAbove);
        if (this.state === "scanning" && Date.now() - last > 500) {
          last = Date.now();
          this.onUpdate();
        }
      },
      AbortSignal.any([this.controller.signal, this.walking.signal]),
    );
  }

  private remove(path: string) {
    for (const key of this.paths.keys()) if (under(key, path)) this.paths.delete(key);
  }

  /** Re-lists directories that gained entries and walks the new directories in them. */
  private async refresh(directories: Iterable<string>) {
    for (const directory of directories) {
      if (directory && !this.paths.get(directory)?.directory) continue;
      const listing = await this.source
        .list(directory, this.showIgnored, this.controller.signal)
        .catch(() => undefined);
      if (!listing || this.controller.signal.aborted || this.state === "machine") continue;
      // An incomplete listing cannot show which paths were removed.
      if (listing.truncated) return this.toMachine();
      const present = new Set(listing.entries.map((entry) => entry.path));
      for (const key of this.paths.keys())
        if (parent(key) === directory && !present.has(key)) this.remove(key);
      const ignoredAbove = this.paths.get(directory)?.ignored ?? false;
      for (const entry of listing.entries) {
        if (this.paths.has(entry.path)) continue;
        const isDirectory = entry.kind === "directory";
        if (!this.insert(entry.path, isDirectory, ignoredAbove || entry.ignored)) return;
        if (isDirectory) await this.walk(entry.path, ignoredAbove || entry.ignored).catch(() => {});
      }
    }
  }

  /** Applies change feed events. Returns false when the list must be rebuilt. */
  apply(event: FolderFeedEvent): boolean {
    if (this.state === "machine") {
      if (event.type === "status" && !event.exists) return false;
      // The machine answers from disk, so changes only need an open filter to ask again.
      if (event.type === "changes" && !this.refreshTimer)
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          if (!this.controller.signal.aborted) this.onUpdate();
        }, MACHINE_FILTER_REFRESH_MS);
      return true;
    }
    if (event.type === "status") return event.exists && this.state !== "failed";
    if (event.type !== "changes") return true;
    if (event.overflow || event.ignoreRulesChanged?.length || event.changes.some(ignoreFileChanged))
      return false;
    const directories = new Set<string>();
    for (const change of event.changes) {
      if (change.type === "deleted") this.remove(change.path);
      else if (change.type === "renamed") {
        this.remove(change.from);
        directories.add(parent(change.to));
      } else if (change.type === "created") directories.add(parent(change.path));
    }
    if (directories.size)
      this.updates = this.updates.then(() => this.refresh(directories)).then(() => this.onUpdate());
    else this.onUpdate();
    return true;
  }

  async match(text: string): Promise<{ matches: FolderNameMatch[]; truncated: boolean }> {
    const needle = text.toLowerCase();
    if (this.state === "machine") {
      // A newer filter text cancels the machine's previous name search.
      this.nameSearch?.abort();
      const search = new AbortController();
      this.nameSearch = search;
      const matches: FolderNameMatch[] = [];
      let truncated = false;
      await this.source.search(
        { query: text, showIgnored: this.showIgnored, names: true },
        (event) => {
          if (event.type === "file") matches.push({ path: event.path, ignored: event.ignored });
          else if (event.type === "done") truncated = event.truncated;
        },
        AbortSignal.any([search.signal, this.controller.signal, AbortSignal.timeout(60_000)]),
      );
      return { matches, truncated };
    }
    const matches: FolderNameMatch[] = [];
    for (const [path, entry] of this.paths) {
      if (entry.directory || !entry.lower.includes(needle)) continue;
      if (matches.length >= MAX_FOLDER_NAME_MATCHES) return { matches, truncated: true };
      matches.push({ path, ignored: entry.ignored });
    }
    return { matches, truncated: false };
  }

  close() {
    clearTimeout(this.refreshTimer);
    this.nameSearch?.abort();
    this.controller.abort();
    this.paths = new Map();
  }
}

function ignoreFileChanged(change: FolderChange) {
  const paths = change.type === "renamed" ? [change.from, change.to] : [change.path];
  return paths.some((path) => path === ".gitignore" || path.endsWith("/.gitignore"));
}

/**
 * Filter and content search for Folder tabs. Neither path lists nor search results are
 * stored; both disappear with the tab's change feed.
 */
export function registerFolderFind(
  { handle, window }: Pick<MainPluginContext, "handle" | "window">,
  folder: (tabId: string) => Promise<{ source: FolderSource }>,
  unavailable: Unavailable,
) {
  const indexes = new Map<string, FolderPaths>();
  const searches = new Map<string, AbortController>();
  const notify = (tabId: string, event: FolderViewEvent["event"]) => {
    if (!window.isDestroyed()) window.webContents.send("scope:folder-event", { tabId, event });
  };

  async function index(tabId: string, showIgnored: boolean) {
    const reusable = () => {
      const current = indexes.get(tabId);
      return current?.showIgnored === showIgnored ? current : undefined;
    };
    const existing = reusable();
    if (existing) return existing;
    const { source } = await folder(tabId);
    const raced = reusable();
    if (raced) return raced;
    indexes.get(tabId)?.close();
    const created: FolderPaths = new FolderPaths(source, showIgnored, () => {
      if (indexes.get(tabId) === created) notify(tabId, { type: "paths", state: created.state });
    });
    indexes.set(tabId, created);
    return created;
  }

  handle("scope:folder-filter", async (input): Promise<FolderFilterResult> => {
    const request = decode(FilterRequest, input);
    try {
      const paths = await index(request.tabId, request.showIgnored);
      if (!request.text) return { status: "ok", state: paths.state, matches: [], truncated: false };
      const result = await paths.match(request.text);
      return { status: "ok", state: paths.state, ...result };
    } catch (error) {
      return unavailable(error, true);
    }
  });

  function cancelSearch(tabId: string) {
    searches.get(tabId)?.abort();
    searches.delete(tabId);
  }
  handle("scope:folder-search", async (input): Promise<FolderSearchResult> => {
    const request = decode(SearchRequest, input);
    // One search per tab: a new query cancels the previous one.
    cancelSearch(request.tabId);
    const controller = new AbortController();
    searches.set(request.tabId, controller);
    const matches: Extract<FolderSearchResult, { status: "ok" }>["matches"] = [];
    let truncated = false;
    let done = false;
    try {
      const { source } = await folder(request.tabId);
      await source.search(
        { query: request.query, showIgnored: request.showIgnored },
        (event) => {
          if (event.type === "match")
            matches.push({ path: event.path, line: event.line, text: event.text });
          else if (event.type === "done") {
            done = true;
            truncated = event.truncated;
          }
        },
        controller.signal,
      );
      return { status: "ok", matches, truncated, cancelled: !done };
    } catch (error) {
      if (controller.signal.aborted) return { status: "ok", matches, truncated, cancelled: true };
      if (error instanceof FolderError && error.code === "no-tab")
        return { status: "error", message: error.message };
      return unavailable(error, true);
    } finally {
      if (searches.get(request.tabId) === controller) searches.delete(request.tabId);
    }
  });
  handle("scope:folder-search-cancel", (input) => cancelSearch(decode(Uuid, input)));

  return {
    /** Keeps the tab's path list current. Called for every change feed event. */
    apply(tabId: string, event: FolderViewEvent["event"]) {
      const paths = indexes.get(tabId);
      if (!paths || event.type === "paths") return;
      const keep = event.type !== "unavailable" && paths.apply(event);
      if (keep) return;
      paths.close();
      indexes.delete(tabId);
      if (event.type === "unavailable" || (event.type === "status" && !event.exists)) return;
      void index(tabId, paths.showIgnored).catch(() => {});
    },
    stop(tabId: string) {
      indexes.get(tabId)?.close();
      indexes.delete(tabId);
      cancelSearch(tabId);
    },
  };
}
