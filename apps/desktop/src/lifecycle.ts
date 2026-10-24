import type { RetainedTab, TrashEntry } from "./workspace/retention.ts";
import type { ShrinkReceipt } from "@irudd-scope/protocol/maintenance";
import { decode, type DeleteReceipt } from "@irudd-scope/protocol";
import { Tab, decodeWorkspace, emptyWorkspace, type Workspace } from "./workspace/contract.ts";
import type { ArtifactStore } from "./library/store.ts";
import type { DesktopStore } from "./desktop-store.ts";
import { validateTabState } from "./plugins/registry.ts";
import { LegacyMemoryTabState } from "./plugins/memory/contract.ts";
import type { FolderIdentity } from "@irudd-scope/protocol/folder";
import type { FolderSelection, FolderTabOpened } from "./plugins/folder/contract.ts";

export class DesktopLifecycle {
  private pending = Promise.resolve();
  onRemoved: (ids: string[]) => void = () => {};
  onRetentionChanged: (tabs: RetainedTab[]) => void = () => {};
  private visibleIds: readonly string[] = [];
  onClosed: (ids: string[]) => void = () => {};
  /** Tabs closed to the drawer. Their views stay mounted. */
  onHidden: (ids: string[]) => void = () => {};

  constructor(
    readonly artifacts: ArtifactStore,
    readonly desktop: DesktopStore,
    private readonly checkpoint: (point: string) => Promise<void> = async () => {},
  ) {}

  private enqueue<A>(action: () => Promise<A>): Promise<A> {
    const task = this.pending.then(action);
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async recover(): Promise<void> {
    const workspace = await this.desktop.legacyWorkspace();
    await this.artifacts.importTabs(workspace?.tabs ?? [], await this.desktop.closedArtifacts());
    if (!(await this.desktop.layout())) {
      const layout = workspace ?? emptyWorkspace();
      await this.desktop.saveLayout({ groups: layout.groups, selected: layout.selected });
    }
    await this.checkpoint("after-tab-import");
    await this.desktop.finishTabImport();
    await this.artifacts.removeDiagramTabs();
    await this.artifacts.convertLegacyPlans();
    const savedTabs = (await this.artifacts.tabs()).flatMap((row) =>
      row.document ? [decode(Tab, JSON.parse(row.document))] : [],
    );
    if (
      savedTabs.some(
        (tab) => tab.type === "memory" && (tab.state.version === 1 || tab.title !== "Librarian"),
      )
    )
      await this.artifacts.saveTabs(
        savedTabs.map((tab) =>
          tab.type !== "memory"
            ? tab
            : {
                ...tab,
                title: "Librarian",
                state:
                  tab.state.version === 1
                    ? {
                        version: 2,
                        data: {
                          recovery: decode(LegacyMemoryTabState, tab.state).data,
                          original: tab.state,
                        },
                      }
                    : tab.state,
              },
        ),
      );
    await this.reconcile();
  }

  async reconcile(): Promise<number> {
    return this.artifacts.reclaim();
  }

  async shrink(timeoutMs: number): Promise<ShrinkReceipt> {
    const deadline = Date.now() + timeoutMs;
    const databases = [await this.artifacts.maintenance.run(true, timeoutMs)];
    databases.push(await this.desktop.maintenance.run(true, Math.max(1, deadline - Date.now())));
    return { target: "desktop", databases };
  }

  async workspace(): Promise<Workspace> {
    const layout = (await this.desktop.layout()) ?? emptyWorkspace();
    const tabs = (await this.artifacts.tabs()).flatMap((tab) =>
      tab.opened && tab.document && tab.trashed_at === null
        ? [decode(Tab, JSON.parse(tab.document))]
        : [],
    );
    tabs.push(...(await this.desktop.guestRecords()).map((record) => record.tab));
    const groups = [...layout.groups];
    for (const tab of tabs)
      if (!groups.some((group) => group.id === tab.groupId))
        groups.push({ id: tab.groupId, owner: { kind: "workspace", id: tab.groupId } });
    return decodeWorkspace({
      version: 3,
      groups,
      tabs,
      selected: tabs.some((tab) => tab.id === layout.selected && !tab.hidden)
        ? layout.selected
        : (tabs.find((tab) => !tab.hidden)?.id ?? null),
    });
  }

  saveWorkspace(value: unknown): Promise<void> {
    const workspace = decodeWorkspace(value);
    for (const tab of workspace.tabs) validateTabState(tab, true);
    return this.enqueue(async () => {
      const guests = new Set((await this.desktop.guestRecords()).map((record) => record.tab.id));
      if (workspace.tabs.some((tab) => (tab.type === "guest") !== guests.has(tab.id)))
        throw new Error("Guest and local tab identities cannot be exchanged.");
      await this.artifacts.saveTabs(workspace.tabs.filter((tab) => !guests.has(tab.id)));
      await this.desktop.saveGuestTabs(workspace.tabs.filter((tab) => guests.has(tab.id)));
      await this.desktop.saveLayout({ groups: workspace.groups, selected: workspace.selected });
    });
  }

  openTab(value: unknown, artifactRevision?: number): Promise<Tab | null> {
    const tab = decode(Tab, value);
    validateTabState(tab, true);
    return this.enqueue(async () => {
      const guest = (await this.desktop.guestRecords()).find((record) => record.tab.id === tab.id);
      if (guest || tab.type === "guest") {
        if (!guest || tab.type !== "guest") throw new Error("This guest reference is unavailable.");
        await this.desktop.setGuestHidden(tab.id, false);
        return { ...guest.tab, hidden: false };
      }
      const opened = await this.artifacts.openTab(tab, artifactRevision);
      if (opened) await this.notifyRetention();
      return opened;
    });
  }

  private async notifyRetention(): Promise<void> {
    this.onRetentionChanged(await this.artifacts.retainedTabs());
  }

  setTabPermanent(id: string, permanent: boolean): Promise<void> {
    return this.enqueue(async () => {
      if ((await this.desktop.guestRecords()).some((record) => record.tab.id === id))
        throw new Error("Only the owner controls source retention.");
      await this.artifacts.setTabPermanent(id, permanent);
      await this.notifyRetention();
    });
  }

  /**
   * Closes a tab to the drawer or reopens it, in order with agent commands such as
   * `folder open`. Plugins hear about a close before the renderer's request resolves, so
   * a quick reopen cannot hide it, and a renderer save with an older tab cannot undo it.
   */
  setTabHidden(id: string, hidden: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (await this.desktop.setGuestHidden(id, hidden)) return;
      if ((await this.artifacts.setTabHidden(id, hidden)) && hidden) this.onHidden([id]);
    });
  }

  reportVisibleTabs(ids: readonly string[], now = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      await this.artifacts.markTabsVisible([...new Set([...this.visibleIds, ...ids])], now);
      this.visibleIds = ids;
    });
  }

  closeTab(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (await this.desktop.setGuestHidden(id, true)) return;
      const ids = await this.artifacts.trashTab(id);
      this.onRemoved(ids);
      await this.notifyRetention();
      this.onClosed(ids);
    });
  }

  /** Opens, restores, unhides, or renames the one Folder tab for a folder, and can select a file in it. */
  openFolderTab(
    input: FolderIdentity & { title?: string; select?: FolderSelection },
  ): Promise<FolderTabOpened> {
    return this.enqueue(async () => {
      const layout = await this.desktop.layout();
      const groupId = layout?.groups[0]?.id;
      if (!groupId) throw new Error("Scope is still starting. Retry shortly.");
      const opened = await this.artifacts.openFolderTab({ ...input, groupId });
      if (opened.created || opened.restored || opened.unhidden) await this.notifyRetention();
      return opened;
    });
  }

  restoreTab(id: string): Promise<Tab> {
    return this.enqueue(async () => {
      const tab = await this.artifacts.restoreTab(id);
      await this.notifyRetention();
      return tab;
    });
  }

  emptyTrash(entries: readonly TrashEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const ids = await this.artifacts.emptyTrash(entries);
      this.onRemoved(ids);
      await this.notifyRetention();
      this.onClosed(ids);
    });
  }

  checkRetention(visibleIds: readonly string[], now = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      await this.artifacts.markTabsVisible(visibleIds, now);
      const trashed = await this.artifacts.expireTemporaryTabs(now);
      if (trashed.length) this.onRemoved(trashed);
      const deleted = await this.artifacts.emptyTrash(await this.artifacts.expiredTrash(now));
      if (deleted.length) this.onRemoved(deleted);
      if (trashed.length || deleted.length) {
        await this.notifyRetention();
        this.onClosed([...trashed, ...deleted]);
      }
    });
  }

  deleteArtifact(id: string): Promise<DeleteReceipt> {
    return this.enqueue(async () => {
      const tabs = (await this.artifacts.tabs()).filter((tab) => tab.artifact_id === id);
      await this.checkpoint("before-close-commit");
      const deleted = await this.artifacts.removeArtifact(id);
      await this.checkpoint("after-close-commit");
      this.onRemoved(tabs.map((tab) => tab.id));
      await this.checkpoint("after-cleanup");
      await this.notifyRetention();
      this.onClosed(tabs.map((tab) => tab.id));
      return { id, deleted };
    });
  }
}
