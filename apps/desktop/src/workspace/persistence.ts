import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { WorkspaceFlushPurpose } from "./contract.ts";

type Flush = (purpose: WorkspaceFlushPurpose, closingTabId?: string) => Promise<void>;
const saves = new Set<Flush>();
const tabSaves = new Map<string, Set<() => void>>();
export function discardTabSaves(id: string): void {
  for (const discard of tabSaves.get(id) ?? []) discard();
  tabSaves.delete(id);
}

export function beforeClose(
  save: (purpose: WorkspaceFlushPurpose) => Promise<void>,
  owningTabId?: string,
): () => void {
  const flush: Flush = (purpose, closingTabId) =>
    save(
      purpose === "close" && (closingTabId === undefined || closingTabId === owningTabId)
        ? "close"
        : "save",
    );
  saves.add(flush);
  return () => {
    saves.delete(flush);
  };
}

export async function flushWorkspace(
  purpose: WorkspaceFlushPurpose = "save",
  closingTabId?: string,
): Promise<void> {
  const results = await Promise.allSettled([...saves].map((save) => save(purpose, closingTabId)));
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Could not save the workspace.");
}

export function useAutosave<T>(
  getValue: () => T | undefined,
  save: (value: T) => Promise<void>,
  tabId?: string,
) {
  const current = useRef({ getValue, save });
  current.current = { getValue, save };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(Promise.resolve());
  const saved = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const discarded = useRef(false);
  const [error, setError] = useState(false);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (discarded.current) return pending.current;
    const value = current.current.getValue();
    if (value === undefined) return pending.current;
    const document = JSON.stringify(value);
    const write = current.current.save;
    const task = pending.current.then(async () => {
      if (discarded.current || document === saved.current) return;
      await write(value);
      saved.current = document;
    });
    pending.current = task.catch(() => {});
    return task.then(
      () => {
        if (mounted.current) setError(false);
        else saves.delete(flush);
      },
      (failure: unknown) => {
        if (mounted.current) setError(true);
        throw failure;
      },
    );
  }, []);
  const schedule = useCallback(() => {
    if (timer.current === undefined)
      timer.current = setTimeout(() => {
        void flush().catch(() => {});
      }, 250);
  }, [flush, tabId]);
  useLayoutEffect(() => {
    mounted.current = true;
    saves.add(flush);
    const discard = () => {
      discarded.current = true;
      clearTimeout(timer.current);
      saves.delete(flush);
    };
    if (tabId) {
      const entries = tabSaves.get(tabId) ?? new Set();
      entries.add(discard);
      tabSaves.set(tabId, entries);
    }
    return () => {
      if (tabId) {
        tabSaves.get(tabId)?.delete(discard);
        if (!tabSaves.get(tabId)?.size) tabSaves.delete(tabId);
      }
      mounted.current = false;
      // Capture before Excalidraw clears its scene on unmount. Keep the write in the close barrier.
      void flush().then(
        () => {
          if (!mounted.current) saves.delete(flush);
        },
        () => {},
      );
    };
  }, [flush, tabId]);
  return { schedule, flush, error };
}
