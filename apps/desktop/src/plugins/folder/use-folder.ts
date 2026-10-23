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
const MAX_RETRIES = 10;

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

function changedDirectories(changes: readonly FolderChange[]) {
  const directories = new Set<string>();
  for (const change of changes)
    for (const path of change.type === "renamed" ? [change.from, change.to] : [change.path])
      directories.add(parent(path));
  return directories;
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
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const retries = useRef(new Map<string, number>());
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

  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  const load = useCallback(
    async (paths: Iterable<string>) => {
      const requested = [...new Set(paths)];
      const run = generation.current;
      const showIgnored = current.current.showIgnored;
      const results = await listAll(requested, (path) =>
        window.scope
          .folderList({ tabId, path, showIgnored })
          .catch(() => ({ status: "error" as const, message: "Could not read this folder." })),
      );
      if (run !== generation.current) return;
      const root = results[requested.indexOf("")];
      if (root && root.status !== "ok" && root.status !== "missing") {
        setListings(new Map());
        setStatus({ kind: root.status, message: root.message });
        return;
      }
      setListings((previous) => {
        const next = new Map(previous);
        requested.forEach((path, index) => {
          const result = results[index]!;
          if (result.status === "ok") next.set(path, result.listing);
          else if (result.status === "missing")
            for (const key of next.keys())
              if (key === path || key.startsWith(`${path}/`)) next.delete(key);
        });
        return next;
      });
      const retry = requested.filter((path, index) => {
        const result = results[index]!;
        if (result.status === "ok" || result.status === "missing") retries.current.delete(path);
        return result.status !== "ok" && result.status !== "missing";
      });
      setFailed((previous) => {
        const next = new Set(previous);
        for (const path of requested) next.delete(path);
        for (const path of retry) next.add(path);
        return next;
      });
      const again = retry.filter((path) => {
        const count = (retries.current.get(path) ?? 0) + 1;
        retries.current.set(path, count);
        return count <= MAX_RETRIES;
      });
      if (again.length) {
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          if (run === generation.current) void load(again);
        }, RETRY_MS);
      }
      if (root?.status === "ok") setStatus({ kind: "ok" });
    },
    [tabId],
  );

  const reloadAll = useCallback(() => {
    generation.current++;
    retries.current.clear();
    return load(["", ...visibleExpanded(current.current.expanded)]);
  }, [load]);

  const reload = useCallback(
    (directories: Iterable<string>) => {
      for (const directory of directories)
        if (loaded.current.has(directory)) pending.current.add(directory);
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
        else reload(changedDirectories(event.changes));
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
      void window.scope.unwatchFolder(tabId).catch(() => {});
    };
  }, [started, tabId, reloadAll, reload]);

  // An agent's `folder select` can expand folders this view has not read yet.
  useEffect(() => {
    if (!started || statusRef.current.kind !== "ok") return;
    const missing = visibleExpanded(view.expanded).filter((path) => !loaded.current.has(path));
    if (missing.length) void load(missing);
  }, [view.expanded, started, load]);

  const shownIgnored = useRef(view.showIgnored);
  useEffect(() => {
    if (shownIgnored.current === view.showIgnored) return;
    shownIgnored.current = view.showIgnored;
    if (started) void reloadAll();
  }, [view.showIgnored, started, reloadAll]);

  return { listings, failed, status, live, load };
}
