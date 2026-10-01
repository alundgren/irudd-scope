import type { PullRequestStore } from "../../library/pull-request-store.ts";
import type { PullRequestsSnapshot } from "@irudd-scope/protocol/pull-requests";
import { GitHubPullRequests } from "./gh.ts";
import { GitHubReadError } from "./gh-process.ts";

export class PullRequestSync {
  private readonly syncing = new Map<
    string,
    { controller: AbortController; result: Promise<PullRequestsSnapshot> }
  >();
  private readonly details = new Map<AbortController, string>();
  private lastStart = 0;

  constructor(
    private readonly store: PullRequestStore,
    private readonly github = new GitHubPullRequests(),
  ) {}

  sync(tabId: string): Promise<PullRequestsSnapshot> {
    const current = this.syncing.get(tabId);
    if (current) return current.result;
    const controller = new AbortController();
    const startedAt = new Date(
      (this.lastStart = Math.max(Date.now(), this.lastStart + 1)),
    ).toISOString();
    const result = this.refresh(tabId, controller.signal, startedAt).finally(() => {
      if (this.syncing.get(tabId)?.controller === controller) this.syncing.delete(tabId);
    });
    this.syncing.set(tabId, { controller, result });
    return result;
  }

  private async refresh(
    tabId: string,
    signal: AbortSignal,
    startedAt: string,
  ): Promise<PullRequestsSnapshot> {
    const current = await this.store.snapshotByTab(tabId);
    if (!current.repository)
      throw new GitHubReadError("Choose a repository before refreshing pull requests.");
    signal.throwIfAborted();
    try {
      await this.store.setSyncStatus(
        tabId,
        {
          ...current.sync,
          state: "syncing",
          updatedAt: startedAt,
          error: null,
        },
        signal,
      );
      signal.throwIfAborted();
      const inventory = await this.github.inventory(current.repository, signal);
      signal.throwIfAborted();
      return await this.store.commitInventory(
        tabId,
        {
          ...inventory,
          repository: current.repository,
          completedAt: new Date().toISOString(),
        },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      return await this.store.setSyncStatus(
        tabId,
        {
          state: "error",
          updatedAt: new Date().toISOString(),
          lastSuccessAt: current.sync.lastSuccessAt,
          error:
            error instanceof GitHubReadError
              ? error.message
              : "Pull requests could not be refreshed. Try Sync again.",
        },
        signal,
      );
    } finally {
      if (signal.aborted) await this.store.cancelSync(tabId, startedAt);
    }
  }

  async detail(tabId: string, nodeId: string) {
    const controller = new AbortController();
    this.details.set(controller, tabId);
    try {
      const current = await this.store.snapshotByTab(tabId);
      controller.signal.throwIfAborted();
      const pr = current.prs.find((row) => row.nodeId === nodeId);
      if (!current.repository || !pr) throw new GitHubReadError("Open pull request not found.");
      return await this.github.detail(current.repository, pr, controller.signal);
    } finally {
      this.details.delete(controller);
    }
  }

  cancelTabs(tabIds: readonly string[]) {
    const removed = new Set(tabIds);
    for (const [tabId, run] of this.syncing)
      if (removed.has(tabId)) {
        run.controller.abort();
        this.syncing.delete(tabId);
      }
    for (const [controller, tabId] of this.details) if (removed.has(tabId)) controller.abort();
  }

  cancelPending() {
    for (const run of this.syncing.values()) run.controller.abort();
    this.syncing.clear();
    for (const controller of this.details.keys()) controller.abort();
  }
}
