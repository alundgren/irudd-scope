import {
  WORKSPACE_CLOSED_RETENTION_DAYS,
  type WorkspaceBoard,
  type WorkspaceBoardRef,
  type WorkspaceCommitPair,
  type WorkspaceIssue,
  type WorkspaceIssueDetail,
  type WorkspaceIssueFacts,
  type WorkspacePullRequest,
  type WorkspacePullRequestDetail,
  type WorkspacePullRequestFacts,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
} from "@irudd-scope/protocol/workspace";
import type { WorkspaceStore } from "../../library/workspace-store.ts";
import { WorkspaceGitHubClient, type SlimIssueRecord } from "./gh.ts";
import { WorkspaceGitHubError } from "./transport.ts";

export type WorkspaceInterest = {
  tabId: string;
  active: boolean;
  refresh?: boolean;
};

type GroupState = {
  key: string;
  repository: WorkspaceRepository;
  boardRef: WorkspaceBoardRef | null;
  tabs: Set<string>;
  controller: AbortController;
  run?: Promise<void>;
  next: number;
  failures: number;
  cost: number;
  lastSweepAt: number;
  lastSchemaAt: number;
  lastIssueUpdatedAt: string | null;
  issues: Map<string, WorkspaceIssueFacts>;
  prs: Map<string, WorkspacePullRequestFacts>;
  board: WorkspaceBoard | null;
  hasBase: boolean;
};

type Scheduling = {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

const SWEEP_INTERVAL_MS = 180_000;
const SCHEMA_REFRESH_MS = 900_000;
const RETENTION_MS = WORKSPACE_CLOSED_RETENTION_DAYS * 86_400_000;

function groupKey(repository: WorkspaceRepository, boardRef: WorkspaceBoardRef | null): string {
  const repo = `${repository.owner}/${repository.name}`.toLowerCase();
  if (!boardRef) return repo;
  return `${repo}#${boardRef.ownerType}:${boardRef.owner.toLowerCase()}/${boardRef.number}`;
}

function stripIssueFacts(issue: WorkspaceIssue): WorkspaceIssueFacts {
  const { local: _local, agent: _agent, ...facts } = issue;
  return facts;
}

function stripPrFacts(pr: WorkspacePullRequest): WorkspacePullRequestFacts {
  const { local: _local, agent: _agent, ...facts } = pr;
  return facts;
}

function isRepoPullRequest(
  pr: WorkspacePullRequestFacts,
  repository: WorkspaceRepository,
): boolean {
  return pr.url
    .toLowerCase()
    .startsWith(`https://github.com/${repository.owner}/${repository.name}/pull/`.toLowerCase());
}

function isSlimDirty(prev: WorkspaceIssueFacts | undefined, slim: SlimIssueRecord): boolean {
  if (!prev) return true;
  if (prev.updatedAt !== slim.updatedAt) return true;
  if (prev.state !== slim.state || prev.stateReason !== slim.stateReason) return true;
  if (prev.parentIssueId !== slim.parentIssueId || prev.milestoneId !== slim.milestoneId)
    return true;
  if (
    prev.subIssuesSummary.total !== slim.subIssuesSummary.total ||
    prev.subIssuesSummary.completed !== slim.subIssuesSummary.completed
  )
    return true;
  if (
    prev.dependenciesSummary.blockedBy !== slim.dependenciesSummary.blockedBy ||
    prev.dependenciesSummary.blocking !== slim.dependenciesSummary.blocking
  )
    return true;
  return false;
}

export class WorkspaceSync {
  private readonly groups = new Map<string, GroupState>();
  private readonly interests = new Map<string, WorkspaceInterest>();
  private readonly prDetailCache = new Map<string, WorkspacePullRequestDetail>();
  private readonly issueDetailCache = new Map<string, WorkspaceIssueDetail>();
  private readonly charges: { at: number; cost: number }[] = [];
  private account: string | null = null;
  private reserveUntil = 0;
  private paused = false;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private reconciling?: Promise<void>;
  private reconcileRequested = 0;
  private readonly now: () => number;
  private readonly schedule: NonNullable<Scheduling["setTimeout"]>;
  private readonly unschedule: NonNullable<Scheduling["clearTimeout"]>;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly github = new WorkspaceGitHubClient(),
    options: Scheduling = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? setTimeout;
    this.unschedule = options.clearTimeout ?? clearTimeout;
    this.github.setHooks(
      (observation) => {
        if (this.account !== null && this.account !== observation.account) {
          this.prDetailCache.clear();
          this.issueDetailCache.clear();
          this.charges.length = 0;
          this.reserveUntil = 0;
        }
        this.account = observation.account;
        this.charges.push({ at: this.now(), cost: observation.cost });
        if (observation.remaining <= Math.max(100, observation.limit * 0.1)) {
          this.reserveUntil = Math.max(
            this.reserveUntil,
            Number.isFinite(Date.parse(observation.resetAt))
              ? Date.parse(observation.resetAt)
              : this.now() + 60_000,
          );
        }
      },
      (signal) => {
        signal.throwIfAborted();
        if (this.reserveUntil > this.now()) {
          throw new WorkspaceGitHubError(
            "GitHub refresh is waiting for the account query budget.",
            "throttle",
            this.reserveUntil,
          );
        }
      },
    );
  }

  start(): Promise<void> {
    this.started = true;
    return this.reconcile();
  }

  cancelPending(): void {
    this.paused = true;
    if (this.timer) this.unschedule(this.timer);
    this.timer = undefined;
    this.store.cancelReads();
    for (const group of this.groups.values()) group.controller.abort();
    this.groups.clear();
  }

  resume(): Promise<void> {
    this.paused = false;
    return this.reconcile();
  }

  cancelTabs(tabIds: readonly string[]): void {
    for (const tabId of tabIds) {
      this.interests.delete(tabId);
      this.store.cancelReads(tabId);
    }
    void this.reconcile().catch(() => {});
  }

  reconcile(): Promise<void> {
    this.reconcileRequested++;
    if (this.reconciling) return this.reconciling;
    const task = (async () => {
      let observed: number;
      do {
        observed = this.reconcileRequested;
        await this.refreshGroups();
      } while (observed !== this.reconcileRequested);
    })().finally(() => {
      this.reconciling = undefined;
    });
    this.reconciling = task;
    return task;
  }

  private async refreshGroups(): Promise<void> {
    const configured = await this.store.configuredTabs();
    const memberships = new Map<string, Set<string>>();
    for (const tab of configured) {
      const key = groupKey(tab.repository, tab.boardRef);
      const set = memberships.get(key) ?? new Set<string>();
      set.add(tab.tabId);
      memberships.set(key, set);
      if (!this.groups.has(key)) {
        const snapshot = await this.store.snapshotByTab(tab.tabId);
        this.groups.set(key, {
          key,
          repository: tab.repository,
          boardRef: tab.boardRef,
          tabs: set,
          controller: new AbortController(),
          next: 0,
          failures: 0,
          cost: 4,
          lastSweepAt: 0,
          lastSchemaAt: snapshot.board ? this.now() : 0,
          lastIssueUpdatedAt: tab.lastIssueUpdatedAt,
          issues: new Map(snapshot.issues.map((i) => [i.nodeId, stripIssueFacts(i)])),
          prs: new Map(snapshot.prs.map((p) => [p.nodeId, stripPrFacts(p)])),
          board: snapshot.board,
          hasBase: tab.hasBase,
        });
      }
    }
    for (const [key, group] of this.groups) {
      const tabs = memberships.get(key);
      if (!tabs) {
        group.controller.abort();
        this.groups.delete(key);
      } else {
        const added = [...tabs].some((id) => !group.tabs.has(id));
        group.tabs = tabs;
        if (added) group.next = Math.min(group.next, this.now());
      }
    }
    if (this.started && !this.paused) this.arm();
  }

  async interest(interest: WorkspaceInterest): Promise<void> {
    const previous = this.interests.get(interest.tabId);
    this.interests.set(interest.tabId, interest);
    await this.reconcile();
    const group = [...this.groups.values()].find((entry) => entry.tabs.has(interest.tabId));
    if (!group) return;
    if (
      interest.active &&
      !group.failures &&
      (interest.refresh || !previous?.active || !group.hasBase)
    )
      group.next = Math.min(group.next, this.now());
    this.arm();
  }

  private pruneCharges() {
    while (this.charges[0] && this.charges[0].at <= this.now() - 3_600_000) this.charges.shift();
  }

  private budgetUntil() {
    this.pruneCharges();
    let spent = this.charges.reduce((sum, charge) => sum + charge.cost, 0);
    if (spent < 500) return 0;
    for (const charge of this.charges) {
      spent -= charge.cost;
      if (spent < 500) return charge.at + 3_600_000;
    }
    return 0;
  }

  private waitUntil() {
    return Math.max(this.reserveUntil, this.budgetUntil());
  }

  private baseInterval(group: GroupState) {
    return [...group.tabs].some((id) => this.interests.get(id)?.active) ? 90_000 : 300_000;
  }

  private factor(overrideGroup?: GroupState, overrideCost?: number) {
    let hourly = 0;
    for (const group of this.groups.values()) {
      const cost =
        overrideGroup === group && overrideCost !== undefined ? overrideCost : group.cost;
      hourly += (cost * 3_600_000) / this.baseInterval(group);
    }
    return Math.max(1, hourly / 500);
  }

  private interval(group: GroupState, overrideCost?: number) {
    return Math.ceil(this.baseInterval(group) * this.factor(group, overrideCost));
  }

  private cadenceReason(overrideGroup?: GroupState, overrideCost?: number) {
    if (this.reserveUntil > this.now()) return "GitHub query reserve";
    return this.budgetUntil() > this.now() || this.factor(overrideGroup, overrideCost) > 1
      ? "Account query budget"
      : null;
  }

  private arm() {
    if (this.timer) this.unschedule(this.timer);
    this.timer = undefined;
    if (this.paused || !this.started || !this.groups.size) return;
    let next = Infinity;
    for (const group of this.groups.values()) {
      if (!group.run) next = Math.min(next, Math.max(group.next, this.waitUntil()));
    }
    if (Number.isFinite(next)) {
      this.timer = this.schedule(
        () => {
          this.timer = undefined;
          this.tick();
        },
        Math.max(0, next - this.now()),
      );
      this.timer.unref?.();
    }
  }

  private tick() {
    if (this.paused || this.waitUntil() > this.now()) {
      this.arm();
      return;
    }
    for (const group of this.groups.values()) {
      if (!group.run && group.next <= this.now()) void this.runGroup(group, false).catch(() => {});
    }
    this.arm();
  }

  private runGroup(group: GroupState, manual: boolean): Promise<void> {
    if (group.run) return group.run;
    group.run = this.executeSync(group, manual).finally(() => {
      group.run = undefined;
      this.arm();
    });
    return group.run;
  }

  async sync(tabId: string): Promise<WorkspaceSnapshot> {
    await this.reconcile();
    const group = [...this.groups.values()].find((entry) => entry.tabs.has(tabId));
    if (!group)
      throw new WorkspaceGitHubError("Configure a repository before syncing this workspace.");
    if (!this.paused && this.reserveUntil <= this.now()) await this.runGroup(group, true);
    return this.store.snapshotByTab(tabId);
  }

  private async setGroupStatus(
    group: GroupState,
    state: "idle" | "syncing" | "error",
    error: string | null = null,
    boardError?: string | null,
  ) {
    const stamp = new Date(this.now()).toISOString();
    for (const tabId of [...group.tabs]) {
      if (group.controller.signal.aborted) return;
      try {
        const snapshot = await this.store.snapshotByTab(tabId);
        await this.store.setSyncStatus(
          tabId,
          {
            ...snapshot.sync,
            state,
            updatedAt: stamp,
            error,
            ...(boardError !== undefined ? { boardError } : {}),
            intervalMs: this.interval(group),
            nextAttemptAt: new Date(Math.max(group.next, this.waitUntil())).toISOString(),
            reason: this.cadenceReason(),
          },
          group.controller.signal,
        );
      } catch {
        // Tab may have been removed mid-sync.
      }
    }
  }

  private async executeSync(group: GroupState, manual: boolean): Promise<void> {
    const signal = group.controller.signal;
    let totalCost = 0;
    let settledStatus = false;
    try {
      await this.setGroupStatus(group, "syncing", null);

      // 1. Open Pull Requests + check disappeared same-repo PRs for MERGED vs CLOSED
      const prRes = await this.github.readOpenPullRequests(group.repository, signal);
      totalCost += prRes.cost;
      const openPrMap = new Map(prRes.prs.map((pr) => [pr.nodeId, pr]));
      const disappearedIds = [...group.prs.values()]
        .filter(
          (prev) =>
            prev.state === "open" &&
            !openPrMap.has(prev.nodeId) &&
            isRepoPullRequest(prev, prRes.repository),
        )
        .map((prev) => prev.nodeId);
      const nextPrs = new Map<string, WorkspacePullRequestFacts>(group.prs);
      for (const pr of prRes.prs) nextPrs.set(pr.nodeId, pr);
      if (disappearedIds.length) {
        const closedRes = await this.github.readPullRequestsByIds(disappearedIds, signal);
        totalCost += closedRes.cost;
        for (const pr of closedRes.prs) nextPrs.set(pr.nodeId, pr);
      }

      // 2. Repo delta (milestones + issues updated since cursor + ProjectV2.updatedAt watermark)
      const since = group.lastIssueUpdatedAt ?? new Date(this.now() - RETENTION_MS).toISOString();
      const delta = await this.github.readRepoDelta(
        prRes.repository,
        since,
        group.boardRef,
        signal,
      );
      totalCost += delta.cost;
      let boardError = delta.boardError;

      // 3. Open-issue slim relation sweep (initial, manual, or every 3m) to catch silent blockedBy/sub-issue edits
      const slimMap = new Map<string, SlimIssueRecord>(delta.issues.map((i) => [i.nodeId, i]));
      let nextSweepAt = group.lastSweepAt;
      const needsSweep =
        !group.hasBase || manual || this.now() - group.lastSweepAt >= SWEEP_INTERVAL_MS;
      if (needsSweep) {
        const sweep = await this.github.readOpenIssueSweep(prRes.repository, signal);
        totalCost += sweep.cost;
        for (const item of sweep.issues) {
          if (!slimMap.has(item.nodeId)) slimMap.set(item.nodeId, item);
        }
        nextSweepAt = this.now();
      }

      // 4. Optional Board Overlay gated by ProjectV2.updatedAt and schema refresh timer
      let nextBoard = group.board;
      let nextSchemaAt = group.lastSchemaAt;
      if (group.boardRef && !boardError) {
        const schemaExpired = this.now() - group.lastSchemaAt >= SCHEMA_REFRESH_MS;
        const boardChanged =
          !nextBoard ||
          manual ||
          schemaExpired ||
          delta.boardUpdatedAt === null ||
          delta.boardUpdatedAt !== nextBoard.updatedAt;
        if (boardChanged) {
          const reuseSchema =
            nextBoard && !schemaExpired
              ? {
                  nodeId: nextBoard.nodeId,
                  title: nextBoard.title,
                  url: nextBoard.url,
                  fields: nextBoard.fields,
                  views: nextBoard.views,
                }
              : null;
          try {
            const boardRes = await this.github.readBoard(group.boardRef, reuseSchema, signal);
            totalCost += boardRes.cost;
            nextBoard = boardRes.board;
            if (boardRes.schemaRefreshed) nextSchemaAt = this.now();
          } catch (error) {
            if (
              error instanceof WorkspaceGitHubError &&
              (error.kind === "scope" || error.kind === "permission")
            ) {
              boardError = error.message;
            } else {
              throw error;
            }
          }
        }
      } else if (!group.boardRef) {
        nextBoard = null;
      }

      // 5. Dirty issue detection + hydration via nodes(ids)
      const dirtyIds = new Set<string>();
      for (const [nodeId, slim] of slimMap) {
        if (isSlimDirty(group.issues.get(nodeId), slim)) dirtyIds.add(nodeId);
      }
      if (nextBoard) {
        const prevBoardItems = new Map(
          group.board?.items.map((item) => [item.itemId, item.updatedAt]) ?? [],
        );
        for (const item of nextBoard.items) {
          if (item.contentType !== "issue" || !item.contentNodeId) continue;
          const isNew = !group.issues.has(item.contentNodeId);
          const itemUpdated =
            !slimMap.has(item.contentNodeId) && prevBoardItems.get(item.itemId) !== item.updatedAt;
          if (isNew || itemUpdated) dirtyIds.add(item.contentNodeId);
        }
      }

      const nextIssues = new Map<string, WorkspaceIssueFacts>(group.issues);
      if (dirtyIds.size) {
        const hydrated = await this.github.hydrateIssues([...dirtyIds], signal);
        totalCost += hydrated.cost;
        for (const issue of hydrated.issues) nextIssues.set(issue.nodeId, issue);
        for (const stub of hydrated.linkedPrStubs) {
          if (!nextPrs.has(stub.nodeId)) nextPrs.set(stub.nodeId, stub);
        }
      }

      // Advance incremental issue watermark strictly from this repository's issues
      // (subtract 2s to avoid same-second boundary misses).
      let maxUpdatedMs = group.lastIssueUpdatedAt ? Date.parse(group.lastIssueUpdatedAt) : 0;
      for (const slim of slimMap.values()) {
        const ms = Date.parse(slim.updatedAt);
        if (Number.isFinite(ms) && ms > maxUpdatedMs) maxUpdatedMs = ms;
      }
      const nextCursor =
        maxUpdatedMs > 0 ? new Date(Math.max(0, maxUpdatedMs - 2_000)).toISOString() : since;

      const nextCost = Math.max(1, totalCost);
      const nextInterval = this.interval(group, nextCost);
      const nextAttempt = this.now() + nextInterval;
      const completedAt = new Date(this.now()).toISOString();
      const commitPayload = {
        repository: prRes.repository,
        boardRef: group.boardRef,
        expectedRepository: group.repository,
        expectedBoardRef: group.boardRef,
        viewer: prRes.viewer,
        milestones: delta.milestones,
        issues: [...nextIssues.values()],
        prs: [...nextPrs.values()],
        board: nextBoard,
        lastIssueUpdatedAt: nextCursor,
        completedAt,
        boardError,
        syncOverride: {
          state: "idle" as const,
          updatedAt: completedAt,
          lastSuccessAt: completedAt,
          error: null,
          boardError,
          intervalMs: nextInterval,
          nextAttemptAt: new Date(Math.max(nextAttempt, this.waitUntil())).toISOString(),
          reason: this.cadenceReason(group, nextCost),
        },
      };

      let committed: WorkspaceSnapshot | undefined;
      for (const tabId of [...group.tabs]) {
        signal.throwIfAborted();
        committed = await this.store.commitSync(tabId, commitPayload, signal);
      }

      // Apply in-memory state updates only after SQLite commits succeed.
      group.cost = nextCost;
      group.failures = 0;
      group.hasBase = true;
      group.repository = prRes.repository;
      group.board = nextBoard;
      group.lastIssueUpdatedAt = nextCursor;
      group.lastSweepAt = nextSweepAt;
      group.lastSchemaAt = nextSchemaAt;
      group.next = nextAttempt;
      if (committed) {
        group.issues = new Map(committed.issues.map((i) => [i.nodeId, stripIssueFacts(i)]));
        group.prs = new Map(committed.prs.map((p) => [p.nodeId, stripPrFacts(p)]));
      }
      settledStatus = true;
    } catch (error) {
      if (signal.aborted) throw error;
      group.failures++;
      const delay =
        error instanceof WorkspaceGitHubError &&
        (error.kind === "auth" || error.kind === "permission")
          ? 900_000
          : Math.min(3_600_000, 60_000 * 2 ** Math.min(group.failures - 1, 6));
      group.next = Math.max(
        this.now() + delay,
        error instanceof WorkspaceGitHubError ? (error.retryAt ?? 0) : 0,
      );
      if (error instanceof WorkspaceGitHubError && error.kind === "throttle")
        this.reserveUntil = group.next;
      const msg =
        error instanceof WorkspaceGitHubError
          ? error.message
          : "Workspace could not be refreshed. Scope will retry automatically.";
      await this.setGroupStatus(group, "error", msg);
      settledStatus = true;
    } finally {
      if (!settledStatus && signal.aborted && !this.paused) {
        const stamp = new Date(this.now()).toISOString();
        for (const tabId of [...group.tabs]) {
          try {
            const snapshot = await this.store.snapshotByTab(tabId);
            if (snapshot.sync.state === "syncing") {
              await this.store.setSyncStatus(tabId, {
                ...snapshot.sync,
                state: "idle",
                updatedAt: stamp,
              });
            }
          } catch {
            // Tab may have been removed or database closed.
          }
        }
      }
    }
  }

  async prDetail(
    tabId: string,
    nodeId: string,
    captured?: WorkspaceCommitPair,
    signal?: AbortSignal,
  ): Promise<WorkspacePullRequestDetail> {
    signal?.throwIfAborted();
    const snapshot = await this.store.snapshotByTab(tabId);
    if (!snapshot.repository) throw new WorkspaceGitHubError("Configure a repository first.");
    const pr = snapshot.prs.find((row) => row.nodeId === nodeId);
    if (!pr) throw new WorkspaceGitHubError("Pull request not found in workspace.");
    if (
      captured &&
      ((pr.headOid && captured.headOid !== pr.headOid) ||
        (pr.baseOid && captured.baseOid !== pr.baseOid))
    )
      throw new WorkspaceGitHubError(
        "This pull request updated. Load the latest commits to view details.",
        "comparison",
      );
    const cacheKey = `${snapshot.repository.owner}/${snapshot.repository.name}/${nodeId}/${pr.headOid ?? "none"}/${pr.baseOid ?? "none"}`;
    const cached = this.prDetailCache.get(cacheKey);
    if (cached) return cached;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const detail = await this.github.readPullRequestDetail(
        snapshot.repository,
        pr,
        controller.signal,
      );
      this.prDetailCache.set(cacheKey, detail);
      while (this.prDetailCache.size > 48)
        this.prDetailCache.delete(this.prDetailCache.keys().next().value!);
      return detail;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async issueDetail(
    tabId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceIssueDetail> {
    signal?.throwIfAborted();
    const snapshot = await this.store.snapshotByTab(tabId);
    const issue = snapshot.issues.find((row) => row.nodeId === nodeId);
    if (!issue) throw new WorkspaceGitHubError("Issue not found in workspace.");
    const cacheKey = `${nodeId}/${issue.updatedAt}`;
    const cached = this.issueDetailCache.get(cacheKey);
    if (cached) return cached;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const detail = await this.github.readIssueDetail(nodeId, controller.signal);
      this.issueDetailCache.set(cacheKey, detail);
      while (this.issueDetailCache.size > 64)
        this.issueDetailCache.delete(this.issueDetailCache.keys().next().value!);
      return detail;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
