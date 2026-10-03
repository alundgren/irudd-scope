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
  private readonly detailCache = new Map<
    string,
    {
      detail: PullRequestDetail;
      bytes: number;
      repository: string;
      nodeId: string;
      headOid: string;
      baseOid: string;
    }
  >();
  private cacheBytes = 0;
  private readonly pendingDetails = new Map<
    string,
    {
      controller: AbortController;
      users: Map<symbol, string>;
      promise: Promise<PullRequestDetail>;
      repository: string;
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
        const blocked = this.reserveUntil;
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
      this.store.cancelReads();
      for (const pending of this.pendingDetails.values()) pending.controller.abort();
      for (const group of this.groups.values()) group.controller.abort();
      this.groups.clear();
      this.detailCache.clear();
      this.cacheBytes = 0;
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
    if (this.detailCache.size || this.pendingDetails.size)
      this.pruneDetails(await this.store.currentComparisons());
    if (this.started && !this.paused) this.arm();
  }

  async interest(interest: PullRequestsInterest): Promise<void> {
    const previous = this.interests.get(interest.tabId);
    this.interests.set(interest.tabId, interest);
    this.releaseDetail();
    await this.reconcile();
    const group = [...this.groups.values()].find((group) => group.tabs.has(interest.tabId));
    if (!group) return;
    if (interest.active && !group.failures) {
      if (interest.refresh || !previous?.active || !group.inventory)
        group.next = Math.min(group.next, this.now());
      if (
        this.watched(interest).length &&
        (interest.refresh ||
          JSON.stringify(previous && this.watched(previous)) !==
            JSON.stringify(this.watched(interest)))
      )
        group.targetNext = Math.min(group.targetNext, this.now());
    }
    if (!this.inspected(group).length) group.targetController?.abort();
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
  private cadenceReason() {
    if (this.reserveUntil > this.now()) return "GitHub query reserve";
    return this.budgetUntil() > this.now() || this.factor() > 1 ? "Account query budget" : null;
  }
  private watched(interest: PullRequestsInterest) {
    return interest.details ?? (interest.detail ? [interest.detail] : []);
  }
  private inspected(group: Group) {
    return [...group.tabs].flatMap((tabId) => {
      const interest = this.interests.get(tabId);
      return interest?.active
        ? this.watched(interest).map((detail) => ({ tabId, detail, interest }))
        : [];
    });
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
            nextAttemptAt: new Date(Math.max(group.next, this.waitUntil())).toISOString(),
            reason: this.cadenceReason(),
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
            nextAttemptAt: new Date(Math.max(group.next, this.waitUntil())).toISOString(),
            reason:
              snapshot.sync.reason === "Loading remaining GitHub facts" &&
              snapshot.sync.state === "syncing"
                ? snapshot.sync.reason
                : this.cadenceReason(),
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
      if (!group.run) next = Math.min(next, Math.max(group.next, this.waitUntil()));
      if (!group.target && this.inspected(group).length)
        next = Math.min(next, Math.max(group.targetNext, this.waitUntil()));
    }
    if (this.waitUntil() > this.now() && !this.accountProbe)
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
    if (this.waitUntil() > this.now()) {
      void this.checkAccount()
        .then(() => this.publishCadence())
        .catch(() => {})
        .finally(() => this.arm());
      return;
    }
    for (const group of this.groups.values()) {
      if (this.now() < this.waitUntil()) continue;
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
        const comparisons = new Map<string, (typeof interests)[number]>();
        for (const interest of interests)
          if (
            interest.detail.nodeId === nodeId &&
            this.interests.get(interest.tabId) === interest.interest
          )
            comparisons.set(`${interest.detail.headOid}/${interest.detail.baseOid}`, interest);
        for (const comparison of comparisons.values()) {
          const captured = comparison.detail;
          const reviews = await this.github.reviews(
            group.repository,
            { ...source, headOid: captured.headOid, baseOid: captured.baseOid },
            signal,
          );
          for (const interest of interests) {
            if (
              interest.detail.nodeId !== nodeId ||
              interest.detail.headOid !== captured.headOid ||
              interest.detail.baseOid !== captured.baseOid ||
              this.interests.get(interest.tabId) !== interest.interest
            )
              continue;
            const cacheKey = `${this.account}/${key(group.repository)}/${nodeId}/${captured.headOid}/${captured.baseOid}`;
            const cached = this.detailCache.get(cacheKey);
            if (cached)
              this.cacheDetail(
                cacheKey,
                { ...cached.detail, ...reviews },
                key(group.repository),
                nodeId,
                captured,
              );
            this.options.onDetail?.({
              tabId: interest.tabId,
              ...interest.detail,
              ...reviews,
              error: null,
            });
          }
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
          if (this.interests.get(interest.tabId) === interest.interest)
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
    if (this.waitUntil() > this.now()) await this.checkAccount();
    await this.reconcile();
    const group = [...this.groups.values()].find((group) => group.tabs.has(tabId));
    if (!group) throw new GitHubReadError("Choose a repository before refreshing pull requests.");
    if (!this.paused && this.reserveUntil > this.now()) await this.publishCadence();
    if (this.paused || this.reserveUntil > this.now()) return this.store.snapshotByTab(tabId);
    await (group.run ?? this.run(group));
    return this.store.snapshotByTab(tabId);
  }

  async detail(
    tabId: string,
    nodeId: string,
    captured?: PullRequestCommitPair,
    signal?: AbortSignal,
  ): Promise<PullRequestDetail> {
    signal?.throwIfAborted();
    await this.reconcile();
    signal?.throwIfAborted();
    const snapshot = await this.store.snapshotByTab(tabId);
    signal?.throwIfAborted();
    const pr = snapshot.prs.find((row) => row.nodeId === nodeId);
    const group =
      snapshot.repository && [...this.groups.values()].find((group) => group.tabs.has(tabId));
    if (!group || !pr || this.paused) throw new GitHubReadError("Open pull request not found.");
    if (captured && (captured.headOid !== pr.headOid || captured.baseOid !== pr.baseOid))
      throw new GitHubReadError(
        "This comparison changed. Load the latest comparison to view its details.",
      );
    const repository = key(group.repository);
    const cacheKey = `${this.account}/${repository}/${nodeId}/${pr.headOid}/${pr.baseOid}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached) {
      this.detailCache.delete(cacheKey);
      this.detailCache.set(cacheKey, cached);
      return cached.detail;
    }
    let pending = this.pendingDetails.get(cacheKey);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      group.controller.signal.addEventListener("abort", abort, { once: true });
      if (group.controller.signal.aborted) controller.abort();
      const entry = {
        controller,
        users: new Map<symbol, string>(),
        repository,
        nodeId,
        headOid: pr.headOid,
        baseOid: pr.baseOid,
        promise: Promise.resolve(undefined as unknown as PullRequestDetail),
      };
      this.pendingDetails.set(cacheKey, entry);
      entry.promise = this.github
        .detail(group.repository, pr, controller.signal)
        .then((detail) => {
          controller.signal.throwIfAborted();
          this.cacheDetail(cacheKey, detail, repository, nodeId, pr);
          return detail;
        })
        .finally(() => {
          group.controller.signal.removeEventListener("abort", abort);
          if (this.pendingDetails.get(cacheKey) === entry) this.pendingDetails.delete(cacheKey);
        });
      pending = entry;
    }
    const entry = pending;
    const token = Symbol();
    entry.users.set(token, tabId);
    return new Promise<PullRequestDetail>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", canceled);
        entry.controller.signal.removeEventListener("abort", stopped);
      };
      const canceled = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Pull request detail loading was canceled."));
      };
      const stopped = () => {
        cleanup();
        reject(new Error("Pull request detail loading was canceled. Retry when ready."));
      };
      signal?.addEventListener("abort", canceled, { once: true });
      entry.controller.signal.addEventListener("abort", stopped, { once: true });
      if (signal?.aborted) canceled();
      if (entry.controller.signal.aborted) stopped();
      void entry.promise.then(
        (detail) => {
          cleanup();
          resolve(detail);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    }).finally(() => {
      entry.users.delete(token);
      this.releaseUnusedDetail(entry);
    });
  }

  private cacheDetail(
    cacheKey: string,
    detail: PullRequestDetail,
    repository: string,
    nodeId: string,
    captured: PullRequestCommitPair,
  ) {
    const previous = this.detailCache.get(cacheKey);
    if (previous) this.cacheBytes -= previous.bytes;
    this.detailCache.delete(cacheKey);
    const bytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
    if (bytes <= 32 * 1024 * 1024) {
      this.detailCache.set(cacheKey, { detail, bytes, repository, nodeId, ...captured });
      this.cacheBytes += bytes;
    }
    while (this.detailCache.size > 64 || this.cacheBytes > 64 * 1024 * 1024) {
      const oldest = this.detailCache.keys().next().value!;
      this.cacheBytes -= this.detailCache.get(oldest)!.bytes;
      this.detailCache.delete(oldest);
    }
  }

  private pruneDetails(
    comparisons: readonly {
      repository: string;
      nodeId: string;
      headOid: string;
      baseOid: string;
    }[],
  ) {
    const current = (entry: {
      repository: string;
      nodeId: string;
      headOid: string;
      baseOid: string;
    }) =>
      comparisons.some(
        (comparison) =>
          comparison.repository === entry.repository &&
          comparison.nodeId === entry.nodeId &&
          comparison.headOid === entry.headOid &&
          comparison.baseOid === entry.baseOid,
      );
    for (const [cacheKey, entry] of this.detailCache)
      if (!current(entry)) {
        this.cacheBytes -= entry.bytes;
        this.detailCache.delete(cacheKey);
      }
    for (const pending of this.pendingDetails.values())
      if (!current(pending)) pending.controller.abort();
  }

  private releaseUnusedDetail(pending: {
    controller: AbortController;
    users: Map<symbol, string>;
    nodeId: string;
    headOid: string;
    baseOid: string;
  }) {
    const watched = [...this.interests.values()].some(
      (interest) =>
        interest.active &&
        this.watched(interest).some(
          (detail) =>
            detail.nodeId === pending.nodeId &&
            detail.headOid === pending.headOid &&
            detail.baseOid === pending.baseOid,
        ),
    );
    if (!pending.users.size && !watched) pending.controller.abort();
  }

  private releaseDetail() {
    for (const pending of this.pendingDetails.values()) this.releaseUnusedDetail(pending);
  }

  cancelTabs(tabIds: readonly string[]) {
    for (const tabId of tabIds) {
      this.store.cancelReads(tabId);
      this.interests.delete(tabId);
      for (const pending of this.pendingDetails.values())
        for (const [token, owner] of pending.users)
          if (owner === tabId) pending.users.delete(token);
      this.releaseDetail();
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
    this.store.cancelReads();
    for (const pending of this.pendingDetails.values()) pending.controller.abort();
    this.probeController?.abort();
    if (this.timer) this.unschedule(this.timer);
    this.timer = undefined;
    for (const group of this.groups.values()) group.controller.abort();
    this.groups.clear();
    this.detailCache.clear();
    this.cacheBytes = 0;
  }
  async resume() {
    this.paused = false;
    await this.reconcile();
  }
}
