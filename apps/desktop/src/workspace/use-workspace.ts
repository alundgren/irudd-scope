import { useEffect, useRef, useState } from "react";
import {
  decodeWorkspace,
  emptyWorkspace,
  importWorkspace,
  type OverlayName,
  type OverlayPosition,
  type Tab,
  type TabGroup,
  type TabState,
  type Workspace,
} from "./contract.ts";
import { validateTabState } from "../plugins/registry.ts";
import { discardTabSaves, flushWorkspace, useAutosave } from "./persistence.ts";
import type { TabDropEdge } from "./use-tab-drag.ts";

function legacyWorkspace(): Workspace {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("scope.workspace.v1") ?? "null");
    if (value) return importWorkspace(value);
  } catch {
    /* Saved browser tabs are optional. */
  }
  return emptyWorkspace();
}

type TabOpen = { tab: Tab; artifactRevision?: number };

export function useWorkspace(onError: (message: string) => void) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const current = useRef(workspace);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const opening = useRef(Promise.resolve());
  const pendingOpens = useRef(new Set<{ closed: Set<string> }>());
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
        for (const pending of pendingOpens.current) for (const id of ids) pending.closed.add(id);
        const previous = current.current;
        const tabs = previous.tabs.filter((tab) => !ids.includes(tab.id));
        replace({
          ...previous,
          tabs,
          selected: tabs.some((tab) => tab.id === previous.selected)
            ? previous.selected
            : (tabs[
                Math.min(
                  tabs.length - 1,
                  Math.max(0, previous.tabs.findIndex((tab) => tab.id === previous.selected) - 1),
                )
              ]?.id ?? null),
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

  function openTab(tab: Tab, artifactRevision?: number): Promise<boolean> {
    const previous = current.current;
    if (previous.tabs.some((entry) => entry.id === tab.id)) {
      replace({ ...previous, selected: tab.id });
      return Promise.resolve(true);
    }
    return queueOpen([{ tab, artifactRevision }], true).then(({ opened }) =>
      opened.some((tab) => current.current.tabs.some((entry) => entry.id === tab.id)),
    );
  }

  function addTabs(tabs: readonly TabOpen[]): Promise<Tab[]> {
    return queueOpen(tabs, false).then(({ handled }) => handled);
  }

  function queueOpen(tabs: readonly TabOpen[], select: boolean) {
    const requests = tabs.map((input) => {
      const request = {
        ...input,
        closed: new Set<string>(),
      };
      pendingOpens.current.add(request);
      return request;
    });
    const task = opening.current.then(async () => {
      const handled: Tab[] = [];
      const openedTabs: Tab[] = [];
      for (const { tab, artifactRevision, closed } of requests) {
        const previous = current.current;
        if (closed.has(tab.id)) {
          handled.push(tab);
          continue;
        }
        const existing = previous.tabs.find((entry) => entry.id === tab.id);
        if (existing) {
          if (select) replace({ ...previous, selected: existing.id });
          handled.push(tab);
          openedTabs.push(existing);
          continue;
        }
        try {
          const opened = await window.scope.openTab(tab, artifactRevision);
          const latest = current.current;
          if (opened && !closed.has(opened.id)) {
            const tabs = latest.tabs.some((entry) => entry.id === opened.id)
              ? latest.tabs
              : [...latest.tabs, opened];
            replace(
              decodeWorkspace({
                ...latest,
                tabs,
                selected: select ? opened.id : (latest.selected ?? opened.id),
              }),
            );
            openedTabs.push(opened);
          }
        } catch (error) {
          onError(error instanceof Error ? error.message : "Could not open this tab.");
        }
        handled.push(tab);
      }
      return { handled, opened: openedTabs };
    });
    void task
      .finally(() => {
        for (const request of requests) pendingOpens.current.delete(request);
      })
      .catch(() => {});
    opening.current = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async function closeTab(id: string): Promise<boolean> {
    try {
      await flushWorkspace();
      await window.scope.closeTab(id);
      return true;
    } catch {
      onError("Could not move this tab to Trashcan. Try again.");
      return false;
    }
  }

  function moveTabToEnd(id: string): void {
    const previous = current.current;
    const tab = previous.tabs.find((entry) => entry.id === id);
    if (tab)
      replace({ ...previous, tabs: [...previous.tabs.filter((entry) => entry.id !== id), tab] });
  }

  function deferTab(id: string): string | null {
    const previous = current.current;
    const index = previous.tabs.findIndex((entry) => entry.id === id);
    if (index < 0) return previous.selected;
    const tabs = previous.tabs.filter((entry) => entry.id !== id);
    const selected =
      previous.selected === id ? (tabs[Math.max(0, index - 1)]?.id ?? id) : previous.selected;
    replace({ ...previous, tabs: [...tabs, previous.tabs[index]], selected });
    return selected;
  }

  function moveTab(id: string, targetId: string, edge: TabDropEdge): void {
    if (id === targetId) return;
    const previous = current.current;
    const tab = previous.tabs.find((entry) => entry.id === id);
    const tabs = previous.tabs.filter((entry) => entry.id !== id);
    const targetIndex = tabs.findIndex((entry) => entry.id === targetId);
    if (!tab || targetIndex < 0) return;
    tabs.splice(targetIndex + (edge === "after" ? 1 : 0), 0, tab);
    replace({ ...previous, tabs });
  }

  function updateTab(
    id: string,
    patch: Partial<Pick<Tab, "state" | "type" | "title" | "overlayPositions">>,
  ): void {
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
  function updateOverlayPosition(
    id: string,
    name: OverlayName,
    position: OverlayPosition | undefined,
  ) {
    const tab = current.current.tabs.find((entry) => entry.id === id);
    if (!tab) return;
    const overlayPositions = { ...tab.overlayPositions };
    if (position) overlayPositions[name] = position;
    else delete overlayPositions[name];
    updateTab(id, { overlayPositions });
  }
  const updateState = (id: string, state: TabState) => updateTab(id, { state });
  return {
    workspace,
    ready,
    save,
    openTab,
    addTabs,
    closeTab,
    deferTab,
    moveTabToEnd,
    moveTab,
    createGroup,
    updateTab,
    updateState,
    updateOverlayPosition,
  };
}
