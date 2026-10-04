import type { RetainedTab, TrashEntry } from "./workspace/retention.ts";
import type { ShrinkReceipt } from "@irudd-scope/protocol/maintenance";
import { decode, type DeleteReceipt } from "@irudd-scope/protocol";
import { Tab, decodeWorkspace, emptyWorkspace, type Workspace } from "./workspace/contract.ts";
import type { ArtifactStore } from "./library/store.ts";
import type { DesktopStore } from "./desktop-store.ts";
import { validateTabState } from "./plugins/registry.ts";

export class DesktopLifecycle {
  private pending = Promise.resolve();
  onRemoved: (ids: string[]) => void = () => {};
  onRetentionChanged: (tabs: RetainedTab[]) => void = () => {};
  private visibleIds: readonly string[] = [];
  onClosed: (ids: string[]) => void = () => {};

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
    await this.artifacts.importTabs(
      workspace?.tabs ?? [],
      await this.desktop.closedArtifacts(),
      await this.desktop.legacyDrafts(),
    );
    if (!(await this.desktop.layout())) {
      const layout = workspace ?? emptyWorkspace();
      await this.desktop.saveLayout({ groups: layout.groups, selected: layout.selected });
    }
    await this.checkpoint("after-tab-import");
    await this.desktop.finishTabImport();
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
      await this.artifacts.saveTabs(workspace.tabs);
      await this.desktop.saveLayout({ groups: workspace.groups, selected: workspace.selected });
    });
  }

  openTab(value: unknown, artifactRevision?: number): Promise<Tab | null> {
    const tab = decode(Tab, value);
    validateTabState(tab, true);
    return this.enqueue(async () => {
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
      await this.artifacts.setTabPermanent(id, permanent);
      await this.notifyRetention();
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
      const ids = await this.artifacts.trashTab(id);
      this.onRemoved(ids);
      await this.notifyRetention();
      this.onClosed(ids);
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
