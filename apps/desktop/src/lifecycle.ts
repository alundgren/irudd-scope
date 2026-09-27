import type { ShrinkReceipt } from "@irudd-scope/protocol/maintenance";
import { decode, type DeleteReceipt } from "@irudd-scope/protocol";
import { Tab, decodeWorkspace, emptyWorkspace, type Workspace } from "./workspace/contract.ts";
import type { ArtifactStore } from "./library/store.ts";
import type { DesktopStore } from "./desktop-store.ts";
import { validateTabState } from "./plugins/registry.ts";

export class DesktopLifecycle {
  private pending = Promise.resolve();
  onRemoved: (ids: string[]) => void = () => {};
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
      tab.opened && tab.document ? [decode(Tab, JSON.parse(tab.document))] : [],
    );
    const groups = [...layout.groups];
    for (const tab of tabs)
      if (!groups.some((group) => group.id === tab.groupId))
        groups.push({ id: tab.groupId, owner: { kind: "workspace", id: tab.groupId } });
    return decodeWorkspace({
      version: 3,
      groups,
      tabs,
      selected: tabs.some((tab) => tab.id === layout.selected)
        ? layout.selected
        : (tabs[0]?.id ?? null),
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

  openTab(value: unknown): Promise<Tab> {
    const tab = decode(Tab, value);
    validateTabState(tab, true);
    return this.enqueue(async () => {
      const current = await this.workspace();
      if (
        current.tabs.length >= 100 &&
        !current.tabs.some(
          (entry) =>
            entry.id === tab.id ||
            (entry.state.data.artifactId === tab.state.data.artifactId &&
              tab.state.data.artifactId),
        )
      )
        throw new Error("Close a tab before opening another. Your artifacts stay in the library.");
      return this.artifacts.openTab(tab);
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
      this.onClosed(tabs.map((tab) => tab.id));
      return { id, deleted };
    });
  }

  closeTab(id: string): Promise<string | null> {
    return this.enqueue(async () => {
      const tabs = await this.artifacts.tabs();
      const tab = tabs.find((entry) => entry.id === id);
      const removed = tab?.artifact_id
        ? tabs.filter((entry) => entry.artifact_id === tab.artifact_id)
        : [{ id }];
      await this.checkpoint("before-close-commit");
      const artifactId = await this.artifacts.removeTab(id);
      await this.checkpoint("after-close-commit");
      this.onRemoved(removed.map((entry) => entry.id));
      await this.checkpoint("after-cleanup");
      this.onClosed(removed.map((entry) => entry.id));
      return artifactId;
    });
  }
}
