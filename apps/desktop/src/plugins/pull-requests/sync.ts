import type { PullRequestStore, PullRequestsInventory } from "../../library/pull-request-store.ts";
import type {
  PullRequestDetail,
  PullRequestCommitPair,
  PullRequestFacts,
  PullRequestsRepository,
  PullRequestsSnapshot,
} from "@irudd-scope/protocol/pull-requests";
import { GitHubPullRequests } from "./gh.ts";
import { GitHubReadError } from "./gh-process.ts";
import type { PullRequestsInterest, PullRequestsDetailUpdate } from "./interest.ts";

type Group = {
  repository: PullRequestsRepository;
  tabs: Set<string>;
  controller: AbortController;
  run?: Promise<void>;
  target?: Promise<void>;
  targetController?: AbortController;
  next: number;
  targetNext: number;
  failures: number;
  cost: number;
  targetCost: number;
  closed: Map<string, string>;
  inventory?: PullRequestsInventory;
  hasBase: boolean;
};
type Scheduling = {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  onDetail?: (update: PullRequestsDetailUpdate) => void;
};
const key = (repository: PullRequestsRepository) =>
  `${repository.owner}/${repository.name}`.toLowerCase();

export class PullRequestSync {
  private readonly groups = new Map<string, Group>();
  private readonly interests = new Map<string, PullRequestsInterest>();
  private readonly detailCache = new Map<string, Promise<PullRequestDetail>>();
  private readonly pendingDetails = new Map<
    string,
    {
      controller: AbortController;
      users: Set<string>;
      nodeId: string;
      headOid: string;
      baseOid: string;
    }
  >();
  private readonly charges: { at: number; cost: number }[] = [];
  private account: string | null = null;
  private reserveUntil = 0;
  private accountCheckAt = -Infinity;
  private accountProbe?: Promise<void>;
  private probeController?: AbortController;
  private paused = false;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private reconciling?: Promise<void>;
  private reconcileRequested = 0;
  private readonly now: () => number;
  private readonly schedule: NonNullable<Scheduling["setTimeout"]>;
  private readonly unschedule: NonNullable<Scheduling["clearTimeout"]>;

  constructor(
    private readonly store: PullRequestStore,
    private readonly github = new GitHubPullRequests(),
    private readonly options: Scheduling = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? setTimeout;
    this.unschedule = options.clearTimeout ?? clearTimeout;
    this.github.setReadHooks(
      (observation) => {
        this.useAccount(observation.account);
        this.charges.push({ at: this.now(), cost: observation.cost });
        if (observation.remaining <= Math.max(100, observation.limit * 0.1))
          this.reserveUntil = Math.max(
            this.reserveUntil,
            Number.isFinite(Date.parse(observation.resetAt))
              ? Date.parse(observation.resetAt)
              : this.now() + 60_000,
          );
      },
      (signal) => {
        signal.throwIfAborted();
        this.pruneCharges();
        const blocked = Math.max(
          this.reserveUntil,
          this.charges.reduce((sum, charge) => sum + charge.cost, 0) >= 500
            ? this.charges[0]!.at + 3_600_000
            : 0,
        );
        if (blocked > this.now())
          throw new GitHubReadError(
            "GitHub refresh is waiting for the account query budget.",
            "throttle",
            blocked,
          );
      },
    );
  }

  private useAccount(account: string) {
    if (this.account !== null && this.account !== account) {
      for (const group of this.groups.values()) group.controller.abort();
      this.groups.clear();
      this.detailCache.clear();
      this.charges.length = 0;
      this.reserveUntil = 0;
      void this.reconcile().catch(() => {});
    }
    this.account = account;
  }

  private checkAccount(): Promise<void> {
    if (this.accountProbe) return this.accountProbe;
    if (this.now() < this.accountCheckAt + 60_000 || this.paused) return Promise.resolve();
    this.accountCheckAt = this.now();
    const controller = new AbortController();
    this.probeController = controller;
    const task = this.github
      .account(controller.signal)
      .then((account) => {
        controller.signal.throwIfAborted();
        this.useAccount(account);
      })
      .catch(() => {})
      .finally(() => {
        this.accountProbe = undefined;
        this.probeController = undefined;
      });
    this.accountProbe = task;
    return task;
  }

  start(): Promise<void> {
    this.started = true;
    return this.reconcile();
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
    const snapshots = await this.store.configuredTabs();
    const memberships = new Map<string, Set<string>>();
    for (const snapshot of snapshots) {
      if (!snapshot.repository) continue;
      const requestedKey = key(snapshot.repository);
      const existing = [...this.groups].find(
        ([groupKey, group]) =>
          groupKey === requestedKey ||
          key(group.repository) === requestedKey ||
          (group.inventory && key(group.inventory.repository) === requestedKey),
      );
      const repoKey = existing?.[0] ?? requestedKey;
      const tabs = memberships.get(repoKey) ?? new Set<string>();
      tabs.add(snapshot.tabId);
      memberships.set(repoKey, tabs);
      if (!this.groups.has(repoKey))
        this.groups.set(repoKey, {
          repository: snapshot.repository,
          tabs,
          controller: new AbortController(),
          next: 0,
          targetNext: 0,
          failures: 0,
          cost: 1,
          targetCost: 2,
          closed: new Map(),
          hasBase: snapshot.viewer !== null,
        });
    }
    for (const [repoKey, group] of this.groups) {
      if (
        snapshots.some(
          (snapshot) =>
            snapshot.repository && key(snapshot.repository) === repoKey && snapshot.viewer !== null,
        )
      )
        group.hasBase = true;
      const tabs = memberships.get(repoKey);
      if (!tabs) {
        group.controller.abort();
        this.groups.delete(repoKey);
      } else {
        const added = [...tabs].filter((tabId) => !group.tabs.has(tabId));
        group.tabs = tabs;
        if (group.inventory && !group.controller.signal.aborted)
          for (const tabId of added)
            await this.store.commitInventory(
              tabId,
              {
                ...group.inventory,
                prs: group.inventory.prs.filter(
                  (pr) => (group.closed.get(pr.nodeId) ?? "") < pr.merge.observedAt,
                ),
              },
              group.controller.signal,
            );
        else if (added.length) group.next = this.now();
      }
    }
    if (this.started && !this.paused) this.arm();
  }

  async interest(interest: PullRequestsInterest): Promise<void> {
    const previous = this.interests.get(interest.tabId);
    this.interests.set(interest.tabId, interest);
    this.releaseDetail(interest);
    await this.reconcile();
    const group = [...this.groups.values()].find((group) => group.tabs.has(interest.tabId));
    if (!group) return;
    if (interest.active && !group.failures) {
      if (interest.refresh || !previous?.active || !group.inventory)
        group.next = Math.min(group.next, this.now());
      if (
        interest.detail &&
        (interest.refresh || JSON.stringify(previous?.detail) !== JSON.stringify(interest.detail))
      )
        group.targetNext = Math.min(group.targetNext, this.now());
    }
    if (!this.inspected(group).length) group.targetController?.abort();
    this.arm();
  }

  private pruneCharges() {
    while (this.charges[0] && this.charges[0].at <= this.now() - 3_600_000) this.charges.shift();
  }
  private inspected(group: Group) {
    return [...group.tabs]
      .map((tabId) => this.interests.get(tabId))
      .filter(
        (interest): interest is PullRequestsInterest => !!interest?.active && !!interest.detail,
      );
  }
  private baseInterval(group: Group) {
    return [...group.tabs].some((tabId) => this.interests.get(tabId)?.active) ? 30_000 : 300_000;
  }
  private factor() {
    let hourly = 0;
    for (const group of this.groups.values())
      hourly +=
        (group.cost * 3_600_000) / this.baseInterval(group) +
        (new Set(this.inspected(group).map((interest) => interest.detail!.nodeId)).size *
          group.targetCost *
          3_600_000) /
          15_000;
    return Math.max(1, hourly / 500);
  }
  private interval(group: Group) {
    return Math.ceil(this.baseInterval(group) * this.factor());
  }
  private async status(
    group: Group,
    state: "idle" | "syncing" | "error",
    error: string | null = null,
    stamp = new Date(this.now()).toISOString(),
  ) {
    for (const tabId of [...group.tabs]) {
      group.controller.signal.throwIfAborted();
      try {
        const snapshot = await this.store.snapshotByTab(tabId);
        await this.store.setSyncStatus(
          tabId,
          {
            ...snapshot.sync,
            state,
            updatedAt: stamp,
            error,
            intervalMs: this.interval(group),
            nextAttemptAt: new Date(Math.max(group.next, this.reserveUntil)).toISOString(),
            reason:
              this.reserveUntil > this.now()
                ? "GitHub query reserve"
                : this.factor() > 1
                  ? "Account query budget"
                  : null,
          },
          group.controller.signal,
        );
      } catch (error) {
        if (group.controller.signal.aborted) throw error;
      }
    }
  }

  private async publishCadence(exclude?: Group) {
    for (const group of this.groups.values()) {
      if (group === exclude || group.controller.signal.aborted) continue;
      if (!group.run && !group.failures && group.inventory && !group.inventory.syncOverride)
        group.next = Math.max(
          this.now(),
          Date.parse(group.inventory.completedAt) + this.interval(group),
        );
      for (const tabId of group.tabs) {
        const snapshot = await this.store.snapshotByTab(tabId);
        await this.store.setSyncStatus(
          tabId,
          {
            ...snapshot.sync,
            intervalMs: this.interval(group),
            nextAttemptAt: new Date(Math.max(group.next, this.reserveUntil)).toISOString(),
            reason:
              snapshot.sync.reason === "Loading remaining GitHub facts" &&
              snapshot.sync.state === "syncing"
                ? snapshot.sync.reason
                : this.factor() > 1
                  ? "Account query budget"
                  : null,
          },
          group.controller.signal,
        );
      }
    }
  }

  private arm() {
    if (this.timer) this.unschedule(this.timer);
    this.timer = undefined;
    if (this.paused || !this.started || !this.groups.size) return;
    let next = Infinity;
    for (const group of this.groups.values()) {
      if (!group.run) next = Math.min(next, Math.max(group.next, this.reserveUntil));
      if (!group.target && this.inspected(group).length)
        next = Math.min(next, Math.max(group.targetNext, this.reserveUntil));
    }
    if (this.reserveUntil > this.now() && !this.accountProbe)
      next = Math.min(next, Math.max(this.now(), this.accountCheckAt + 60_000));
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
    if (this.paused) return;
    if (this.reserveUntil > this.now()) {
      void this.checkAccount().finally(() => this.arm());
      return;
    }
    for (const group of this.groups.values()) {
      if (this.now() < this.reserveUntil) continue;
      // Targeted reads join the subprocess queue before the next inventory page.
      if (!group.target && group.targetNext <= this.now() && this.inspected(group).length) {
        group.target = this.target(group).finally(() => {
          group.target = undefined;
          this.arm();
        });
      }
      if (!group.run && group.next <= this.now()) void this.run(group).catch(() => {});
    }
    this.arm();
  }
  private run(group: Group) {
    group.run = this.inventory(group).finally(() => {
      group.run = undefined;
      this.arm();
    });
    return group.run;
  }
  private retainFacts(
    group: Group,
    inventory: { prs: readonly PullRequestFacts[]; startedAt: string },
  ) {
    const prs = new Map(inventory.prs.map((pr) => [pr.nodeId, pr]));
    for (const previous of group.inventory?.prs ?? []) {
      const incoming = prs.get(previous.nodeId);
      if (
        previous.merge.observedAt > inventory.startedAt &&
        (!incoming || previous.merge.observedAt > incoming.merge.observedAt)
      )
        prs.set(previous.nodeId, previous);
    }
    return [...prs.values()].filter(
      (pr) => (group.closed.get(pr.nodeId) ?? "") < pr.merge.observedAt,
    );
  }

  private async inventory(group: Group) {
    const signal = group.controller.signal;
    const startedAt = new Date(this.now()).toISOString();
    const startedTabs = [...group.tabs];
    try {
      await this.status(group, "syncing", null, startedAt);
      let inventory;
      if (!group.hasBase) {
        const base = await this.github.initialInventory(group.repository, signal);
        signal.throwIfAborted();
        group.inventory = {
          ...base,
          prs: this.retainFacts(group, base),
          completedAt: new Date(this.now()).toISOString(),
          closed: group.closed,
          syncOverride: {
            state: "syncing",
            updatedAt: startedAt,
            lastSuccessAt: null,
            error: null,
            reason: "Loading remaining GitHub facts",
          },
        };
        for (const tabId of [...group.tabs])
          await this.store.commitInventory(tabId, group.inventory, signal);
        group.hasBase = true;
        group.repository = base.repository;
        const enriched = await this.github.enrichInventory(base.repository, base.prs, signal);
        for (const [nodeId, observedAt] of enriched.closed)
          if ((group.closed.get(nodeId) ?? "") < observedAt) group.closed.set(nodeId, observedAt);
        inventory = { ...enriched, startedAt: base.startedAt };
      } else inventory = await this.github.inventory(group.repository, signal);
      signal.throwIfAborted();
      group.cost = Math.max(1, inventory.cost);
      group.inventory = {
        ...inventory,
        prs: this.retainFacts(group, inventory),
        closed: group.closed,
        completedAt: new Date(this.now()).toISOString(),
      };
      for (const tabId of [...group.tabs]) {
        signal.throwIfAborted();
        await this.store.commitInventory(tabId, group.inventory, signal);
      }
      group.hasBase = true;
      group.failures = 0;
      group.next = this.now() + this.interval(group);
      await this.status(group, "idle");
      await this.publishCadence(group);
    } catch (error) {
      if (signal.aborted) throw error;
      await this.failure(group, error);
    } finally {
      if (signal.aborted)
        for (const tabId of startedTabs)
          await this.store.cancelSync(tabId, startedAt).catch(() => {});
    }
  }
  private async failure(group: Group, error: unknown) {
    group.failures++;
    const delay =
      error instanceof GitHubReadError && (error.kind === "auth" || error.kind === "permission")
        ? 900_000
        : Math.min(3_600_000, 60_000 * 2 ** Math.min(group.failures - 1, 6));
    group.next = Math.max(
      this.now() + delay,
      error instanceof GitHubReadError ? (error.retryAt ?? 0) : 0,
    );
    group.targetNext = group.next;
    if (error instanceof GitHubReadError && error.kind === "throttle")
      this.reserveUntil = group.next;
    if (group.inventory?.syncOverride)
      group.inventory.syncOverride = {
        ...group.inventory.syncOverride,
        state: "error",
        updatedAt: new Date(this.now()).toISOString(),
        error:
          error instanceof GitHubReadError
            ? error.message
            : "Pull requests could not be refreshed. Scope will retry automatically.",
        nextAttemptAt: new Date(group.next).toISOString(),
      };
    await this.status(
      group,
      "error",
      error instanceof GitHubReadError
        ? error.message
        : "Pull requests could not be refreshed. Scope will retry automatically.",
    );
  }
  private async target(group: Group) {
    const controller = new AbortController();
    group.targetController = controller;
    const abort = () => controller.abort();
    group.controller.signal.addEventListener("abort", abort, { once: true });
    if (group.controller.signal.aborted) controller.abort();
    const signal = controller.signal;
    const chargesBefore = this.charges.reduce((sum, charge) => sum + charge.cost, 0);
    const interests = this.inspected(group);
    try {
      const snapshot = await this.store.snapshotByTab(interests[0]!.tabId);
      for (const nodeId of new Set(interests.map((interest) => interest.detail!.nodeId))) {
        const source = snapshot.prs.find((pr) => pr.nodeId === nodeId);
        if (!source) continue;
        let closedAt = new Date(
          Math.max(this.now(), Date.parse(source.merge.observedAt) + 1),
        ).toISOString();
        const facts = await this.github.current(group.repository, source, signal, (observedAt) => {
          closedAt = observedAt;
        });
        signal.throwIfAborted();
        if (!facts) {
          group.closed.set(nodeId, closedAt);
          if (group.inventory)
            group.inventory = {
              ...group.inventory,
              prs: group.inventory.prs.filter(
                (pr) => pr.nodeId !== nodeId || pr.merge.observedAt > closedAt,
              ),
            };
        }
        if (facts && group.inventory)
          group.inventory = {
            ...group.inventory,
            prs: group.inventory.prs.map((pr) =>
              pr.nodeId === facts.nodeId && pr.merge.observedAt < facts.merge.observedAt
                ? facts
                : pr,
            ),
          };
        for (const tabId of [...group.tabs])
          await this.store.commitCurrent(tabId, group.repository, source, facts, signal, closedAt);
        if (!facts) continue;
        const captured = interests.find(
          (interest) =>
            interest.detail?.nodeId === nodeId && this.interests.get(interest.tabId) === interest,
        )?.detail;
        if (!captured) continue;
        const reviews = await this.github.reviews(
          group.repository,
          { ...source, headOid: captured.headOid, baseOid: captured.baseOid },
          signal,
        );
        for (const interest of interests) {
          if (interest.detail?.nodeId !== nodeId || this.interests.get(interest.tabId) !== interest)
            continue;
          const cacheKey = `${this.account}/${key(group.repository)}/${nodeId}/${interest.detail.headOid}/${interest.detail.baseOid}`;
          const cached = this.detailCache.get(cacheKey);
          if (cached) {
            const updated = cached.then((detail) => ({ ...detail, ...reviews }));
            this.detailCache.set(cacheKey, updated);
            void updated.catch(() => {
              if (this.detailCache.get(cacheKey) === updated) this.detailCache.delete(cacheKey);
            });
          }
          this.options.onDetail?.({
            tabId: interest.tabId,
            ...interest.detail,
            ...reviews,
            error: null,
          });
        }
      }
      const spent = this.charges.reduce((sum, charge) => sum + charge.cost, 0) - chargesBefore;
      if (spent > 0)
        group.targetCost = Math.max(
          2,
          spent / Math.max(1, new Set(interests.map((interest) => interest.detail!.nodeId)).size),
        );
      group.targetNext = this.now() + Math.ceil(15_000 * this.factor());
      if (spent > 0) await this.publishCadence();
    } catch (error) {
      if (!signal.aborted) {
        await this.failure(group, error);
        for (const interest of interests)
          if (this.interests.get(interest.tabId) === interest)
            this.options.onDetail?.({
              tabId: interest.tabId,
              ...interest.detail!,
              fetchedAt: new Date(this.now()).toISOString(),
              error:
                error instanceof GitHubReadError
                  ? error.message
                  : "Pull request detail could not be refreshed.",
            });
      }
    } finally {
      group.controller.signal.removeEventListener("abort", abort);
      group.targetController = undefined;
    }
  }

  async sync(tabId: string): Promise<PullRequestsSnapshot> {
    if (this.reserveUntil > this.now()) await this.checkAccount();
    await this.reconcile();
    const group = [...this.groups.values()].find((group) => group.tabs.has(tabId));
    if (!group) throw new GitHubReadError("Choose a repository before refreshing pull requests.");
    if (this.paused || this.reserveUntil > this.now()) return this.store.snapshotByTab(tabId);
    await (group.run ?? this.run(group));
    return this.store.snapshotByTab(tabId);
  }

  async detail(
    tabId: string,
    nodeId: string,
    captured?: PullRequestCommitPair,
  ): Promise<PullRequestDetail> {
    await this.reconcile();
    const snapshot = await this.store.snapshotByTab(tabId);
    const pr = snapshot.prs.find((row) => row.nodeId === nodeId);
    const group =
      snapshot.repository && [...this.groups.values()].find((group) => group.tabs.has(tabId));
    if (!group || !pr || this.paused) throw new GitHubReadError("Open pull request not found.");
    if (captured && (captured.headOid !== pr.headOid || captured.baseOid !== pr.baseOid))
      throw new GitHubReadError(
        "This comparison changed. Load the latest comparison to view its details.",
      );
    const cacheKey = `${this.account}/${key(group.repository)}/${nodeId}/${pr.headOid}/${pr.baseOid}`;
    let detail = this.detailCache.get(cacheKey);
    if (!detail) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      group.controller.signal.addEventListener("abort", abort, { once: true });
      if (group.controller.signal.aborted) controller.abort();
      this.pendingDetails.set(cacheKey, {
        controller,
        users: new Set([tabId]),
        nodeId,
        headOid: pr.headOid,
        baseOid: pr.baseOid,
      });
      detail = this.github.detail(group.repository, pr, controller.signal).finally(() => {
        group.controller.signal.removeEventListener("abort", abort);
        this.pendingDetails.delete(cacheKey);
      });
      this.detailCache.set(cacheKey, detail);
      const result = detail;
      void detail.catch(() => {
        if (this.detailCache.get(cacheKey) === result) this.detailCache.delete(cacheKey);
      });
    } else this.pendingDetails.get(cacheKey)?.users.add(tabId);
    return detail;
  }

  private releaseDetail(interest: PullRequestsInterest) {
    for (const pending of this.pendingDetails.values()) {
      if (
        !interest.active ||
        !interest.detail ||
        interest.detail.nodeId !== pending.nodeId ||
        interest.detail.headOid !== pending.headOid ||
        interest.detail.baseOid !== pending.baseOid
      )
        pending.users.delete(interest.tabId);
      if (!pending.users.size) pending.controller.abort();
    }
  }

  cancelTabs(tabIds: readonly string[]) {
    for (const tabId of tabIds) {
      this.interests.delete(tabId);
      this.releaseDetail({ tabId, active: false, detail: null });
      for (const [repoKey, group] of this.groups) {
        group.tabs.delete(tabId);
        if (!group.tabs.size) {
          group.controller.abort();
          this.groups.delete(repoKey);
        }
      }
    }
    this.arm();
  }
  cancelPending() {
    this.paused = true;
    this.probeController?.abort();
    if (this.timer) this.unschedule(this.timer);
    this.timer = undefined;
    for (const group of this.groups.values()) group.controller.abort();
    this.groups.clear();
    this.detailCache.clear();
  }
  async resume() {
    this.paused = false;
    await this.reconcile();
  }
}
