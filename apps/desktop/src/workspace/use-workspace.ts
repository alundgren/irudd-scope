import { useEffect, useRef, useState } from "react";
import {
  decodeWorkspace,
  emptyWorkspace,
  importWorkspace,
  type Tab,
  type TabGroup,
  type TabState,
  type Workspace,
} from "./contract.ts";
import { validateTabState } from "../plugins/registry.ts";
import { flushWorkspace, useAutosave } from "./persistence.ts";

function legacyWorkspace(): Workspace {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("scope.workspace.v1") ?? "null");
    if (value) return importWorkspace(value);
  } catch {
    /* Saved browser tabs are optional. */
  }
  return emptyWorkspace();
}

export function useWorkspace(onError: (message: string) => void) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const current = useRef(workspace);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const save = useAutosave(
    () => (loaded ? current.current : undefined),
    (value) => window.scope.saveWorkspace(value),
  );
  function replace(next: Workspace): void {
    current.current = next;
    setWorkspace(next);
  }
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
        replace(initial);
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
    if (loaded) save.schedule();
  }, [workspace, loaded, save.schedule]);

  function createGroup(owner: TabGroup["owner"], id = crypto.randomUUID()): TabGroup {
    const previous = current.current;
    const existing = previous.groups.find((group) => group.id === id);
    if (existing) {
      if (existing.owner.kind !== owner.kind || existing.owner.id !== owner.id)
        throw new Error("The group already belongs to another owner.");
      return existing;
    }
    const group = { id, owner };
    replace(decodeWorkspace({ ...previous, groups: [...previous.groups, group] }));
    return group;
  }

  function openTab(tab: Tab): boolean {
    const previous = current.current;
    if (!previous.tabs.some((entry) => entry.id === tab.id) && previous.tabs.length >= 100) {
      onError("Close a tab before opening another. Your artifacts stay in the library.");
      return false;
    }
    const existing = [...previous.tabs, ...previous.closed].find((entry) => entry.id === tab.id);
    const entry = existing ?? tab;
    replace(
      decodeWorkspace({
        ...previous,
        tabs: previous.tabs.some((item) => item.id === entry.id)
          ? previous.tabs
          : [...previous.tabs, entry],
        selected: entry.id,
        closed: previous.closed.filter((item) => item.id !== entry.id),
      }),
    );
    return true;
  }

  function addTabs(tabs: readonly Tab[]): string | null {
    const previous = current.current;
    const existing = new Set([...previous.tabs, ...previous.closed].map((tab) => tab.id));
    const added = tabs.filter((tab) => !existing.has(tab.id));
    const available = 100 - previous.tabs.length;
    if (added.length > available)
      onError("Close a tab before opening another. Your artifacts stay in the library.");
    const next = [...previous.tabs, ...added.slice(0, available)];
    const selected = previous.selected ?? next[0]?.id ?? null;
    if (next.length !== previous.tabs.length)
      replace(decodeWorkspace({ ...previous, tabs: next, selected }));
    return selected;
  }

  async function closeTab(id: string): Promise<boolean> {
    try {
      await flushWorkspace();
    } catch {
      onError("Could not save this tab. Keep it open and try closing it again.");
      return false;
    }
    const previous = current.current;
    const tab = previous.tabs.find((entry) => entry.id === id);
    if (!tab) return true;
    const remaining = previous.tabs.filter((entry) => entry.id !== id);
    replace({
      ...previous,
      tabs: remaining,
      selected:
        previous.selected === id
          ? (remaining[Math.max(0, previous.tabs.indexOf(tab) - 1)]?.id ?? null)
          : previous.selected,
      closed: [...previous.closed, tab],
    });
    return true;
  }

  function updateTab(id: string, patch: Partial<Pick<Tab, "state" | "type" | "title">>): void {
    const previous = current.current;
    const update = (tab: Tab) => {
      if (tab.id !== id) return tab;
      const next = { ...tab, ...patch };
      validateTabState(next);
      return next;
    };
    replace(
      decodeWorkspace({
        ...previous,
        tabs: previous.tabs.map(update),
        closed: previous.closed.map(update),
      }),
    );
  }
  const updateState = (id: string, state: TabState) => updateTab(id, { state });
  return {
    workspace,
    ready,
    save,
    openTab,
    addTabs,
    closeTab,
    createGroup,
    updateTab,
    updateState,
  };
}
