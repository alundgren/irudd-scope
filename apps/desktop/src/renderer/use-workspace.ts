import { useEffect, useState } from "react";
import type { Workspace } from "../workspace.ts";
import { flushWorkspace, useAutosave } from "./persistence.ts";

function legacyWorkspace(): Workspace {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("scope.workspace.v1") ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "tabs" in value &&
      Array.isArray(value.tabs) &&
      value.tabs.length <= 100 &&
      value.tabs.every((id) => typeof id === "string") &&
      "selected" in value &&
      (typeof value.selected === "string" || value.selected === null)
    )
      return { tabs: value.tabs, selected: value.selected };
  } catch {
    /* Saved tabs are optional. */
  }
  return { tabs: [], selected: null };
}

export function useWorkspace(onError: (message: string) => void) {
  const [workspace, setWorkspace] = useState<Workspace>({ tabs: [], selected: null });
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const save = useAutosave(
    () => (loaded ? workspace : undefined),
    (value) => window.scope.saveWorkspace(value),
  );

  useEffect(() => window.scope.onBeforeClose(flushWorkspace), []);
  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await window.scope.workspace();
      const initial = saved ?? legacyWorkspace();
      if (saved === null) await window.scope.saveWorkspace(initial);
      try {
        localStorage.removeItem("scope.workspace.v1");
      } catch {
        /* Legacy storage may be unavailable. */
      }
      if (active) {
        setWorkspace(initial);
        setLoaded(true);
      }
    })()
      .catch(() => {
        if (active) onError("Could not load saved tabs. Your artifacts remain on this Mac.");
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [onError]);
  useEffect(() => {
    if (ready && loaded) save.schedule();
  }, [workspace, ready, loaded, save.schedule]);

  function openTab(id: string): boolean {
    if (!workspace.tabs.includes(id) && workspace.tabs.length >= 100) {
      onError("Close a tab before opening another. Your artifacts stay in the library.");
      return false;
    }
    setWorkspace((previous) => ({
      tabs: previous.tabs.includes(id) ? previous.tabs : [...previous.tabs, id],
      selected: id,
      closed: previous.closed?.filter((entry) => entry !== id) ?? [],
    }));
    return true;
  }

  async function closeTab(id: string): Promise<boolean> {
    try {
      await flushWorkspace();
    } catch {
      onError("Could not save this tab. Keep it open and try closing it again.");
      return false;
    }
    setWorkspace((previous) => {
      if (!previous.tabs.includes(id)) return previous;
      const remaining = previous.tabs.filter((tab) => tab !== id);
      return {
        tabs: remaining,
        selected:
          previous.selected === id
            ? (remaining[Math.max(0, previous.tabs.indexOf(id) - 1)] ?? null)
            : previous.selected,
        closed: [...(previous.closed ?? []).filter((entry) => entry !== id), id],
      };
    });
    return true;
  }

  return { workspace, ready, save, openTab, closeTab };
}
