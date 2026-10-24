import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderChange, FolderListing } from "@irudd-scope/protocol/folder";
import type { FolderUnavailable, FolderViewEvent } from "./contract.ts";

export type FolderStatus = { kind: "loading" | "ok" | FolderUnavailable; message?: string };

function parent(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Expanded folders whose parents are all expanded, so their rows can be visible. */
export function visibleExpanded(expanded: readonly string[]): string[] {
  const set = new Set(expanded);
  return expanded.filter((path) => {
    for (let above = parent(path); above; above = parent(above)) if (!set.has(above)) return false;
    return true;
  });
}

const MAX_LISTINGS = 6;
const RETRY_MS = 2000;
const MAX_RETRIES = 5;

/** A folder that could not be listed: retried automatically a few times, then by request. */
export type FolderFailure = "retrying" | "failed";

/** Runs listings a few at a time, so expanding many folders never exceeds request limits. */
async function listAll<T>(paths: readonly string[], list: (path: string) => Promise<T>) {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const index = next++;
      results[index] = await list(paths[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_LISTINGS, paths.length) }, worker));
  return results;
}

/** Whether `path` is `directory` or inside it; the folder itself is `""`. */
function within(path: string, directory: string) {
  return !directory || path === directory || path.startsWith(`${directory}/`);
}

const isIgnoreFile = (path: string) => path === ".gitignore" || path.endsWith("/.gitignore");

/**
 * The directories a change event says have new ignore rules, `""` for the whole folder
 * after `.git/info/exclude` changes. Read by name so older feeds without it still work.
 */
function ignoreRulesChanged(event: object): string[] {
  const value: unknown = (event as { ignoreRulesChanged?: unknown }).ignoreRulesChanged;
  return Array.isArray(value) ? value.filter((path) => typeof path === "string") : [];
}

/**
 * What a change batch means for the cached listings: `parents` list the changed entries,
 * `replaced` paths were deleted, created, or renamed, so any listing at or below them
 * describes another directory, and ignore rules changed for everything below `rules`.
 */
function affected(changes: readonly FolderChange[], ignoreRules: readonly string[]) {
  const parents = new Set<string>();
  const replaced: { path: string; exists: boolean }[] = [];
  const rules = new Set(ignoreRules);
  for (const change of changes) {
    const paths =
      change.type === "renamed"
        ? [
            { path: change.from, exists: false },
            { path: change.to, exists: true },
          ]
        : [{ path: change.path, exists: change.type !== "deleted" }];
    for (const { path, exists } of paths) {
      parents.add(parent(path));
      if (change.type !== "changed") replaced.push({ path, exists });
      if (isIgnoreFile(path)) rules.add(parent(path));
    }
  }
  return { parents, replaced, rules };
}

/**
 * Loads only the directories a Folder tab shows and reloads them when the folder's change
 * feed reports changes. Nothing is kept once the folder becomes unavailable.
 */
export function useFolder(
  tabId: string,
  view: { expanded: readonly string[]; showIgnored: boolean },
  active: boolean,
) {
  const [listings, setListings] = useState<ReadonlyMap<string, FolderListing>>(new Map());
  // Folders whose listing failed for a reason other than being gone. They are retried and
  // never shown as empty.
  const [failed, setFailed] = useState<ReadonlyMap<string, FolderFailure>>(new Map());
  const retries = useRef(new Map<string, number>());
  // Every folder waiting for its next try; one timer retries them all together.
  const waiting = useRef(new Set<string>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState<FolderStatus>({ kind: "loading" });
  const [live, setLive] = useState(true);
  const [started, setStarted] = useState(active);
  const current = useRef(view);
  current.current = view;
  const loaded = useRef<ReadonlyMap<string, FolderListing>>(listings);
  loaded.current = listings;
  const statusRef = useRef(status);
  statusRef.current = status;
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  // The newest listing request for each folder. An older answer, or one for a folder that
  // was replaced since, would show entries that are no longer there.
  const requests = useRef(new Map<string, number>());
  const requestCount = useRef(0);

  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  const load = useCallback(
    async (paths: Iterable<string>) => {
      const requested = [...new Set(paths)];
      const run = generation.current;
      const showIgnored = current.current.showIgnored;
      const tokens = requested.map((path) => {
        const token = ++requestCount.current;
        requests.current.set(path, token);
        return token;
      });
      const results = await listAll(requested, (path) =>
        window.scope
          .folderList({ tabId, path, showIgnored })
          .catch(() => ({ status: "error" as const, message: "Could not read this folder." })),
      );
      if (run !== generation.current) return;
      const fresh = requested.flatMap((path, index) => {
        if (requests.current.get(path) !== tokens[index]) return [];
        requests.current.delete(path);
        return [{ path, result: results[index]! }];
      });
      const root = fresh.find(({ path }) => path === "")?.result;
      if (root && root.status !== "ok" && root.status !== "missing") {
        setListings(new Map());
        setStatus({ kind: root.status, message: root.message });
        return;
      }
      setListings((previous) => {
        const next = new Map(previous);
        for (const { path, result } of fresh)
          if (result.status === "ok") next.set(path, result.listing);
          else if (result.status === "missing")
            for (const key of next.keys()) if (within(key, path)) next.delete(key);
        return next;
      });
      const outcome = new Map<string, FolderFailure | undefined>();
      for (const { path, result } of fresh) {
        if (result.status === "ok" || result.status === "missing") {
          retries.current.delete(path);
          outcome.set(path, undefined);
          continue;
        }
        const count = (retries.current.get(path) ?? 0) + 1;
        retries.current.set(path, count);
        outcome.set(path, count <= MAX_RETRIES ? "retrying" : "failed");
        if (count <= MAX_RETRIES) waiting.current.add(path);
      }
      setFailed((previous) => {
        const next = new Map(previous);
        for (const [path, state] of outcome)
          if (state) next.set(path, state);
          else next.delete(path);
        return next;
      });
      if (waiting.current.size && !retryTimer.current)
        retryTimer.current = setTimeout(() => {
          retryTimer.current = undefined;
          const paths = [...waiting.current];
          waiting.current.clear();
          void load(paths);
        }, RETRY_MS);
      if (root?.status === "ok") setStatus({ kind: "ok" });
    },
    [tabId],
  );

  /** Tries a folder again after automatic retries gave up. */
  const retry = useCallback(
    (path: string) => {
      retries.current.delete(path);
      setFailed((previous) => {
        const next = new Map(previous);
        next.set(path, "retrying");
        return next;
      });
      void load([path]);
    },
    [load],
  );

  /** The folders at or below `directory` whose rows the tree can show now. */
  const shownWithin = useCallback(
    (directory: string) =>
      ["", ...visibleExpanded(current.current.expanded)].filter((path) => within(path, directory)),
    [],
  );

  const reloadAll = useCallback(() => {
    generation.current++;
    retries.current.clear();
    waiting.current.clear();
    requests.current.clear();
    const shown = shownWithin("");
    const kept = new Set(shown);
    // Collapsed folders' listings may be out of date; they are read again when opened.
    setListings((previous) => {
      const next = new Map([...previous].filter(([path]) => kept.has(path)));
      return next.size === previous.size ? previous : next;
    });
    return load(shown);
  }, [load, shownWithin]);

  const reload = useCallback(
    (directories: Iterable<string>) => {
      for (const directory of directories) pending.current.add(directory);
      if (!pending.current.size || timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        const paths = [...pending.current];
        pending.current.clear();
        void load(paths);
      }, 50);
    },
    [load],
  );

  /**
   * Forgets the listings at or below `path`, because the folder there was deleted or
   * replaced, and drops answers still on their way for them. Listings in `shown` stay on
   * screen until they are read again.
   */
  const forget = useCallback((path: string, shown: ReadonlySet<string>) => {
    const below = (key: string) => within(key, path);
    for (const key of requests.current.keys()) if (below(key)) requests.current.delete(key);
    for (const key of pending.current) if (below(key)) pending.current.delete(key);
    for (const key of retries.current.keys()) if (below(key)) retries.current.delete(key);
    for (const key of waiting.current) if (below(key)) waiting.current.delete(key);
    const without = <T>(previous: ReadonlyMap<string, T>) => {
      const next = new Map([...previous].filter(([key]) => !below(key) || shown.has(key)));
      return next.size === previous.size ? previous : next;
    };
    loaded.current = without(loaded.current);
    setListings(without);
    setFailed(without);
  }, []);

  const applyChanges = useCallback(
    (changes: readonly FolderChange[], ignoreRules: readonly string[]) => {
      const { parents, replaced, rules } = affected(changes, ignoreRules);
      const reads = new Set([...parents].filter((path) => loaded.current.has(path)));
      // A created or renamed folder may arrive with files that have no events of their own,
      // so its open folders are read again.
      for (const { path, exists } of replaced) {
        const shown = exists ? shownWithin(path) : [];
        forget(path, new Set(shown));
        for (const directory of shown) reads.add(directory);
      }
      // Ignore rules apply to every folder below a changed `.gitignore`.
      for (const directory of rules) {
        for (const path of loaded.current.keys()) if (within(path, directory)) reads.add(path);
        for (const path of shownWithin(directory)) reads.add(path);
      }
      reload(reads);
    },
    [forget, reload, shownWithin],
  );

  useEffect(() => {
    if (!started) return;
    void reloadAll();
    const stop = window.scope.onFolderEvent(({ tabId: id, event }: FolderViewEvent) => {
      if (id !== tabId) return;
      if (event.type === "status") {
        setLive(event.live);
        if (!event.exists) {
          generation.current++;
          setListings(new Map());
          setStatus({ kind: "gone" });
        } else if (statusRef.current.kind !== "ok") void reloadAll();
      } else if (event.type === "changes") {
        if (event.overflow) void reloadAll();
        else applyChanges(event.changes, ignoreRulesChanged(event));
      } else if (event.type === "unavailable") {
        generation.current++;
        setListings(new Map());
        setStatus({ kind: event.reason, message: event.message });
      }
    });
    void window.scope.watchFolder(tabId).catch(() => {});
    return () => {
      stop();
      clearTimeout(timer.current);
      clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
      void window.scope.unwatchFolder(tabId).catch(() => {});
    };
  }, [started, tabId, reloadAll, applyChanges]);

  // Expanding a folder, in the tree or by an agent's `folder select`, reads the folders
  // this view has not read yet, also once the first listing finishes. Folders that failed
  // are left to their retries. The key keeps this to real changes; the expanded list is a
  // new array on every render.
  const expandedKey = view.expanded.join("\n");
  const failedNow = useRef(failed);
  failedNow.current = failed;
  useEffect(() => {
    if (!started || status.kind !== "ok") return;
    const missing = visibleExpanded(current.current.expanded).filter(
      (path) => !loaded.current.has(path) && !failedNow.current.has(path),
    );
    if (missing.length) void load(missing);
  }, [expandedKey, started, status.kind, load]);

  const shownIgnored = useRef(view.showIgnored);
  useEffect(() => {
    if (shownIgnored.current === view.showIgnored) return;
    shownIgnored.current = view.showIgnored;
    if (started) void reloadAll();
  }, [view.showIgnored, started, reloadAll]);

  return { listings, failed, status, live, load, retry };
}
