import { useEffect, useRef, useState } from "react";
import {
  decodeWorkspace,
  emptyWorkspace,
  importWorkspace,
  type Tab,
  type TabGroup,
  tabArtifactId,
  type TabState,
  type Workspace,
} from "./contract.ts";
import { validateTabState } from "../plugins/registry.ts";
import { discardTabSaves, flushWorkspace, useAutosave } from "./persistence.ts";

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
  const opening = useRef(Promise.resolve());
  const save = useAutosave(
    () => (loaded ? current.current : undefined),
    (value) => window.scope.saveWorkspace(value),
  );
  function replace(next: Workspace): void {
    current.current = next;
    setWorkspace(next);
  }
  useEffect(() => window.scope.onBeforeClose(flushWorkspace), []);
  useEffect(
    () =>
      window.scope.onTabsClosed((ids) => {
        for (const id of ids) discardTabSaves(id);
        const previous = current.current;
        const tabs = previous.tabs.filter((tab) => !ids.includes(tab.id));
        replace({
          ...previous,
          tabs,
          selected: tabs.some((tab) => tab.id === previous.selected)
            ? previous.selected
            : (tabs[Math.max(0, previous.tabs.findIndex((tab) => tab.id === previous.selected) - 1)]
                ?.id ?? null),
        });
      }),
    [],
  );
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

  function openTab(tab: Tab): Promise<boolean> {
    return queueOpen([tab], true).then(() =>
      current.current.tabs.some(
        (entry) =>
          entry.id === tab.id ||
          Boolean(tabArtifactId(tab) && tabArtifactId(entry) === tabArtifactId(tab)),
      ),
    );
  }

  function addTabs(tabs: readonly Tab[]): Promise<string | null> {
    return queueOpen(tabs, false);
  }

  function queueOpen(tabs: readonly Tab[], select: boolean): Promise<string | null> {
    const task = opening.current.then(async () => {
      for (const tab of tabs) {
        const previous = current.current;
        const artifactId = tabArtifactId(tab);
        const existing = previous.tabs.find(
          (entry) => entry.id === tab.id || (artifactId && tabArtifactId(entry) === artifactId),
        );
        if (existing) {
          if (select) replace({ ...previous, selected: existing.id });
          continue;
        }
        if (previous.tabs.length >= 100) {
          onError("Close a tab before opening another. Your artifacts stay in the library.");
          break;
        }
        try {
          const opened = await window.scope.openTab(tab);
          const latest = current.current;
          if (!latest.tabs.some((entry) => entry.id === opened.id))
            replace(
              decodeWorkspace({
                ...latest,
                tabs: [...latest.tabs, opened],
                selected: select ? opened.id : (latest.selected ?? opened.id),
              }),
            );
        } catch (error) {
          onError(error instanceof Error ? error.message : "Could not open this tab.");
        }
      }
      return current.current.selected;
    });
    opening.current = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async function closeTab(id: string): Promise<boolean> {
    try {
      await save.flush();
      await window.scope.closeTab(id);
      return true;
    } catch {
      onError("Could not close this tab. Try closing it again.");
      return false;
    }
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
