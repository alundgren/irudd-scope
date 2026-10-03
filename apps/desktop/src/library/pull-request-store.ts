import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, ScopeError, decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  PullRequestsCommand,
  PullRequestsAppState,
  type PullRequestsStateChange,
  PullRequestsReply,
  PullRequestsSnapshot,
  PullRequestsSync,
  PullRequestsRepository,
  PullRequestFacts,
  PullRequestLocal,
  PullRequestAgent,
  PullRequestDetail,
  type PullRequestDetailResult,
  type PullRequestCommitPair,
  MAX_PULL_REQUESTS_REPLY_BYTES,
} from "@irudd-scope/protocol/pull-requests";

type Database = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  mutate: <A, E>(effect: Effect.Effect<A, E>, events: (result: A) => LiveEvent[]) => Promise<A>;
};
type Owner = {
  tab_id: string;
  document: string;
  trashed_at: number | null;
  generation: number;
  repository: string | null;
  viewer: string | null;
  sync: string;
  app_state: string;
};
const emptySync: PullRequestsSync = {
  state: "idle",
  updatedAt: null,
  lastSuccessAt: null,
  error: null,
};
const emptyLocal: PullRequestLocal = {
  note: "",
  noteVersion: 0,
  snooze: null,
  snoozeVersion: 0,
  inspected: null,
  reviewed: null,
  reviewVersion: 0,
};
const emptyAgent: PullRequestAgent = { version: 0, assessment: null, customFields: [] };
export type PullRequestsHandlers = {
  sync: (tabId: string) => Promise<PullRequestsSnapshot>;
  detail: (
    tabId: string,
    nodeId: string,
    captured?: PullRequestCommitPair,
    signal?: AbortSignal,
  ) => Promise<PullRequestDetail>;
};
export type PullRequestsInventory = {
  repository: PullRequestsRepository;
  queriedRepository?: PullRequestsRepository;
  viewer: string | null;
  prs: readonly PullRequestFacts[];
  completedAt: string;
  startedAt?: string;
  syncOverride?: PullRequestsSync;
  closed?: ReadonlyMap<string, string>;
};

export function initializePullRequestsTab(
  sql: SqliteClient.SqliteClient,
  tabId: string,
  artifact: Artifact,
) {
  if (artifact.kind !== "pull-requests") return Effect.void;
  return sql`INSERT INTO pull_requests_state(tab_id, generation, repository, viewer, sync) VALUES (${tabId}, 0, NULL, NULL, ${JSON.stringify(emptySync)}) ON CONFLICT(tab_id) DO NOTHING`;
}

export class PullRequestStore {
  private handlers: PullRequestsHandlers | undefined;
  private readonly reads = new Map<AbortController, { tabId: string; requestId: string }>();
  constructor(private readonly database: Database) {}
  setHandlers(handlers: PullRequestsHandlers | undefined): void {
    this.handlers = handlers;
  }

  cancelReads(tabId?: string, requestIds?: readonly string[]): void {
    for (const [controller, read] of this.reads)
      if ((!tabId || read.tabId === tabId) && (!requestIds || requestIds.includes(read.requestId)))
        controller.abort(new Error("Pull request detail loading was canceled. Retry when ready."));
  }

  async currentComparisons(): Promise<
    readonly { repository: string; nodeId: string; headOid: string; baseOid: string }[]
  > {
    const { sql, run } = this.database;
    return run(sql<{ repository: string; nodeId: string; headOid: string; baseOid: string }>`
      SELECT lower(json_extract(state.repository, '$.owner') || '/' || json_extract(state.repository, '$.name')) AS repository,
        json_extract(current.facts, '$.nodeId') AS nodeId,
        json_extract(current.facts, '$.headOid') AS headOid,
        json_extract(current.facts, '$.baseOid') AS baseOid
      FROM pull_requests_current AS current
      JOIN pull_requests_state AS state ON state.tab_id = current.tab_id
      JOIN live_tabs ON live_tabs.id = current.tab_id
      WHERE live_tabs.trashed_at IS NULL`);
  }

  async initialize(): Promise<void> {
    const { sql, run } = this.database;
    const [{ user_version }] = await run(sql<{ user_version: number }>`PRAGMA user_version`);
    if (user_version >= 7) {
      return;
    }
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE pull_requests_state(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK(generation >= 0), repository TEXT CHECK(repository IS NULL OR json_valid(repository)), viewer TEXT, sync TEXT NOT NULL CHECK(json_valid(sync))) STRICT`;
          yield* sql`CREATE TABLE pull_requests_current(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, facts TEXT NOT NULL CHECK(json_valid(facts)), local TEXT NOT NULL CHECK(json_valid(local)), agent TEXT NOT NULL CHECK(json_valid(agent)), PRIMARY KEY(tab_id, node_id)) STRICT`;
          yield* sql`CREATE TABLE pull_requests_receipts(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, node_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(tab_id, request_id), FOREIGN KEY(tab_id, node_id) REFERENCES pull_requests_current(tab_id, node_id) ON DELETE CASCADE) STRICT`;
          const existing = yield* sql<{
            tab_id: string;
            document: string;
          }>`SELECT tab_id, document FROM artifacts WHERE json_extract(document, '$.kind') = 'pull-requests'`;
          for (const row of existing)
            yield* initializePullRequestsTab(
              sql,
              row.tab_id,
              decode(Artifact, JSON.parse(row.document)),
            );
          yield* sql`PRAGMA user_version = 7`;
        }),
      ),
    );
  }

  async recoverInterruptedSync(): Promise<void> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      read = this.read.bind(this);
    const updatedAt = new Date().toISOString();
    await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const changed = yield* sql<{
            tab_id: string;
          }>`UPDATE pull_requests_state SET sync = json_set(sync, '$.state', 'error', '$.updatedAt', ${updatedAt}, '$.error', 'GitHub refresh was interrupted. Try Sync again.'), generation = generation + 1 WHERE json_extract(sync, '$.state') = 'syncing' RETURNING tab_id`;
          const snapshots: PullRequestsSnapshot[] = [];
          for (const row of changed) snapshots.push(yield* read(yield* owner(row.tab_id, true)));
          return snapshots;
        }),
      ),
      (snapshots) => snapshots.flatMap((snapshot) => this.event(snapshot)),
    );
  }

  private owner(key: string, byTab = false) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const rows =
        yield* sql<Owner>`SELECT artifacts.tab_id, artifacts.document, live_tabs.trashed_at, pull_requests_state.generation, pull_requests_state.repository, pull_requests_state.viewer, pull_requests_state.sync, pull_requests_state.app_state FROM artifacts JOIN live_tabs ON live_tabs.id = artifacts.tab_id JOIN pull_requests_state ON pull_requests_state.tab_id = artifacts.tab_id WHERE ${byTab ? sql`artifacts.tab_id = ${key}` : sql`json_extract(artifacts.document, '$.name') = ${key}`} AND json_extract(artifacts.document, '$.kind') = 'pull-requests'`;
      if (!rows[0]) return yield* Effect.fail(new ScopeError(404, "Pull request tab not found."));
      return rows[0];
    });
  }
  private active(owner: Owner) {
    return owner.trashed_at === null
      ? Effect.void
      : Effect.fail(
          new ScopeError(409, "This pull request tab is in Trashcan. Restore it before updating."),
        );
  }
  private read(owner: Owner) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const rows = yield* sql<{
        facts: string;
        local: string;
        agent: string;
      }>`SELECT facts, local, agent FROM pull_requests_current WHERE tab_id = ${owner.tab_id} ORDER BY json_extract(facts, '$.number') DESC`;
      const snapshot = decode(PullRequestsSnapshot, {
        artifact: JSON.parse(owner.document),
        tabId: owner.tab_id,
        generation: owner.generation,
        repository: owner.repository ? JSON.parse(owner.repository) : null,
        viewer: owner.viewer,
        sync: JSON.parse(owner.sync),
        appState: JSON.parse(owner.app_state),
        prs: rows.map((row) => ({
          ...JSON.parse(row.facts),
          local: JSON.parse(row.local),
          agent: JSON.parse(row.agent),
        })),
      });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_PULL_REQUESTS_REPLY_BYTES)
        return yield* Effect.fail(new ScopeError(413, "Pull request snapshot exceeds 32 MiB."));
      return snapshot;
    });
  }
  private event(
    snapshot: PullRequestsSnapshot,
    stateChange?: PullRequestsStateChange,
  ): LiveEvent[] {
    return [
      {
        type: "pull-requests",
        name: snapshot.artifact.name!,
        id: snapshot.artifact.id,
        generation: snapshot.generation,
        tabId: snapshot.tabId,
        ...(stateChange ? { stateChange } : {}),
      },
    ];
  }
  async snapshot(name: string): Promise<PullRequestsSnapshot> {
    return this.load(name, false);
  }
  async snapshotByTab(tabId: string): Promise<PullRequestsSnapshot> {
    return this.load(tabId, true);
  }
  private async load(key: string, byTab: boolean) {
    const { sql, run } = this.database;
    const owner = this.owner.bind(this),
      read = this.read.bind(this);
    return run(
      sql.withTransaction(
        Effect.gen(function* () {
          return yield* read(yield* owner(key, byTab));
        }),
      ),
    );
  }

  async configuredTabs(): Promise<
    Pick<PullRequestsSnapshot, "tabId" | "repository" | "sync" | "viewer">[]
  > {
    const { sql, run } = this.database;
    const rows = await run(
      sql<{
        tab_id: string;
        repository: string;
        sync: string;
        viewer: string | null;
      }>`SELECT pull_requests_state.tab_id, pull_requests_state.repository, pull_requests_state.sync, pull_requests_state.viewer FROM pull_requests_state JOIN live_tabs ON live_tabs.id = pull_requests_state.tab_id JOIN artifacts ON artifacts.tab_id = pull_requests_state.tab_id WHERE live_tabs.trashed_at IS NULL AND pull_requests_state.repository IS NOT NULL AND json_extract(artifacts.document, '$.kind') = 'pull-requests'`,
    );
    return rows.map((row) => ({
      tabId: row.tab_id,
      viewer: row.viewer,
      repository: decode(PullRequestsRepository, JSON.parse(row.repository)),
      sync: decode(PullRequestsSync, JSON.parse(row.sync)),
    }));
  }

  async commitCurrent(
    tabId: string,
    repository: PullRequestsRepository,
    source: PullRequestFacts,
    facts: PullRequestFacts | null,
    signal?: AbortSignal,
    closedAt = source.merge.observedAt,
  ): Promise<PullRequestsSnapshot> {
    Schema.decodeUnknownSync(PullRequestFacts)(source);
    if (facts) {
      decode(PullRequestFacts, facts);
      if (
        facts.url.toLowerCase() !==
          `https://github.com/${repository.owner}/${repository.name}/pull/${facts.number}`.toLowerCase() ||
        facts.merge.headOid !== facts.headOid ||
        facts.merge.baseOid !== facts.baseOid ||
        (facts.checks.status !== "unknown" && facts.checks.headOid !== facts.headOid)
      )
        throw new ScopeError(400, "Pull request facts refer to another repository or commit.");
    }
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      active = this.active.bind(this),
      read = this.read.bind(this);
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(tabId, true);
          yield* active(current);
          if (
            !current.repository ||
            JSON.stringify(JSON.parse(current.repository)).toLowerCase() !==
              JSON.stringify(repository).toLowerCase()
          )
            return yield* Effect.fail(
              new ScopeError(409, "The repository changed during synchronization."),
            );
          yield* Effect.sync(() => signal?.throwIfAborted());
          const [row] = yield* sql<{
            facts: string;
          }>`SELECT facts FROM pull_requests_current WHERE tab_id = ${tabId} AND node_id = ${source.nodeId}`;
          if (row) {
            const previous = decode(PullRequestFacts, JSON.parse(row.facts));
            if (
              facts
                ? previous.merge.observedAt <= facts.merge.observedAt
                : previous.merge.observedAt <= closedAt
            ) {
              if (facts) {
                if (facts.nodeId !== source.nodeId || facts.number !== source.number)
                  return yield* Effect.fail(new ScopeError(400, "Pull request identity changed."));
                yield* sql`UPDATE pull_requests_current SET facts = ${JSON.stringify(facts)}, local = CASE WHEN json_extract(local, '$.snooze.wakeOnNewCommit') = 1 AND json_extract(local, '$.snooze.headOid') != ${facts.headOid} THEN json_set(local, '$.snooze', json('null'), '$.snoozeVersion', json_extract(local, '$.snoozeVersion') + 1) ELSE local END WHERE tab_id = ${tabId} AND node_id = ${source.nodeId}`;
              } else
                yield* sql`DELETE FROM pull_requests_current WHERE tab_id = ${tabId} AND node_id = ${source.nodeId}`;
              yield* sql`UPDATE pull_requests_state SET generation = generation + 1 WHERE tab_id = ${tabId}`;
            }
          }
          yield* Effect.sync(() => signal?.throwIfAborted());
          return yield* read(yield* owner(tabId, true));
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  async setSyncStatus(
    tabId: string,
    value: PullRequestsSync,
    signal?: AbortSignal,
  ): Promise<PullRequestsSnapshot> {
    const sync = decode(PullRequestsSync, value);
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      active = this.active.bind(this),
      read = this.read.bind(this);
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* active(yield* owner(tabId, true));
          yield* Effect.sync(() => signal?.throwIfAborted());
          yield* sql`UPDATE pull_requests_state SET sync = ${JSON.stringify(sync)}, generation = generation + 1 WHERE tab_id = ${tabId}`;
          yield* Effect.sync(() => signal?.throwIfAborted());
          const snapshot = yield* read(yield* owner(tabId, true));
          yield* Effect.sync(() => signal?.throwIfAborted());
          return snapshot;
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  async cancelSync(tabId: string, expectedUpdatedAt: string): Promise<void> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      read = this.read.bind(this);
    await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{
            sync: string;
          }>`SELECT pull_requests_state.sync FROM pull_requests_state JOIN artifacts ON artifacts.tab_id = pull_requests_state.tab_id WHERE pull_requests_state.tab_id = ${tabId} AND json_extract(artifacts.document, '$.kind') = 'pull-requests'`;
          if (!row) return null;
          const current = decode(PullRequestsSync, JSON.parse(row.sync));
          if (current.state !== "syncing" || current.updatedAt !== expectedUpdatedAt) return null;
          const sync: PullRequestsSync = {
            ...current,
            state: "idle",
            updatedAt: new Date().toISOString(),
            error: null,
          };
          yield* sql`UPDATE pull_requests_state SET sync = ${JSON.stringify(sync)}, generation = generation + 1 WHERE tab_id = ${tabId}`;
          return yield* read(yield* owner(tabId, true));
        }),
      ),
      (snapshot) => (snapshot ? this.event(snapshot) : []),
    );
  }

  async commitInventory(
    tabId: string,
    value: PullRequestsInventory,
    signal?: AbortSignal,
  ): Promise<PullRequestsSnapshot> {
    const repository = decode(PullRequestsRepository, value.repository);
    const queriedRepository = decode(
      PullRequestsRepository,
      value.queriedRepository ?? value.repository,
    );
    const prs = value.prs.map((pr) => decode(PullRequestFacts, pr));
    if (
      new Set(prs.map((pr) => pr.nodeId)).size !== prs.length ||
      new Set(prs.map((pr) => pr.number)).size !== prs.length
    )
      throw new ScopeError(400, "Invalid or oversized complete pull request inventory.");
    for (const pr of prs) {
      if (
        pr.url.toLowerCase() !==
        `https://github.com/${repository.owner}/${repository.name}/pull/${pr.number}`.toLowerCase()
      )
        throw new ScopeError(400, "Pull request belongs to another repository.");
      if (
        pr.merge.headOid !== pr.headOid ||
        pr.merge.baseOid !== pr.baseOid ||
        (pr.checks.status !== "unknown" && pr.checks.headOid !== pr.headOid)
      )
        throw new ScopeError(400, "Pull request checks or merge status refer to another commit.");
    }
    const sync = decode(
      PullRequestsSync,
      value.syncOverride ?? {
        state: "idle",
        updatedAt: value.completedAt,
        lastSuccessAt: value.completedAt,
        error: null,
      },
    );
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      active = this.active.bind(this),
      read = this.read.bind(this);
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(tabId, true);
          yield* active(current);
          if (
            !current.repository ||
            JSON.stringify(JSON.parse(current.repository)).toLowerCase() !==
              JSON.stringify(queriedRepository).toLowerCase()
          )
            return yield* Effect.fail(
              new ScopeError(409, "The repository changed during synchronization."),
            );
          if (
            JSON.stringify(JSON.parse(current.repository)).toLowerCase() !==
            JSON.stringify(repository).toLowerCase()
          ) {
            const existing = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM pull_requests_current WHERE tab_id = ${tabId}`;
            if (
              current.viewer !== null ||
              JSON.parse(current.sync).lastSuccessAt !== null ||
              existing[0].count !== 0
            )
              return yield* Effect.fail(
                new ScopeError(
                  409,
                  "The repository resolved to another name after an earlier sync.",
                ),
              );
          }
          yield* Effect.sync(() => signal?.throwIfAborted());
          const currentPrs = prs.filter(
            (pr) => (value.closed?.get(pr.nodeId) ?? "") < pr.merge.observedAt,
          );
          for (const [nodeId, closedAt] of value.closed ?? [])
            if (!currentPrs.some((pr) => pr.nodeId === nodeId))
              yield* sql`DELETE FROM pull_requests_current WHERE tab_id = ${tabId} AND node_id = ${nodeId} AND json_extract(facts, '$.merge.observedAt') <= ${closedAt}`;
          for (const pr of currentPrs)
            yield* sql`INSERT INTO pull_requests_current(tab_id, node_id, facts, local, agent)
              VALUES (${tabId}, ${pr.nodeId}, ${JSON.stringify(pr)}, ${JSON.stringify(emptyLocal)}, ${JSON.stringify(emptyAgent)})
              ON CONFLICT(tab_id, node_id) DO UPDATE SET facts = excluded.facts,
                local = CASE
                  WHEN json_extract(pull_requests_current.local, '$.snooze.wakeOnNewCommit') = 1
                    AND json_extract(pull_requests_current.local, '$.snooze.headOid') != json_extract(excluded.facts, '$.headOid')
                  THEN json_set(pull_requests_current.local,
                    '$.snooze', json('null'),
                    '$.snoozeVersion', json_extract(pull_requests_current.local, '$.snoozeVersion') + 1)
                  ELSE pull_requests_current.local
                END
              WHERE json_extract(pull_requests_current.facts, '$.merge.observedAt') <= json_extract(excluded.facts, '$.merge.observedAt')`;
          yield* sql`DELETE FROM pull_requests_current WHERE tab_id = ${tabId} AND node_id NOT IN (SELECT value FROM json_each(${JSON.stringify(currentPrs.map((pr) => pr.nodeId))})) AND json_extract(facts, '$.merge.observedAt') <= ${value.startedAt ?? value.completedAt}`;
          yield* sql`UPDATE pull_requests_state SET repository = ${JSON.stringify(repository)}, viewer = ${value.viewer}, sync = ${JSON.stringify(sync)}, generation = generation + 1 WHERE tab_id = ${tabId}`;
          yield* Effect.sync(() => signal?.throwIfAborted());
          const snapshot = yield* read(yield* owner(tabId, true));
          yield* Effect.sync(() => signal?.throwIfAborted());
          return snapshot;
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  private async details(
    pinned: PullRequestsSnapshot,
    nodeIds: readonly string[],
    signal: AbortSignal,
  ): Promise<PullRequestsReply> {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(
      () =>
        controller.abort(new Error("Detail batch reached its deadline. Retry this PR separately.")),
      20_000,
    );
    const results: PullRequestDetailResult[] = nodeIds.map((nodeId) => ({
      nodeId,
      error: "Detail batch reached its deadline. Retry this PR separately.",
    }));
    const reply = () => ({ type: "details" as const, tabId: pinned.tabId, results });
    let replyBytes = Buffer.byteLength(JSON.stringify(reply()), "utf8");
    const replace = (index: number, result: PullRequestDetailResult) => {
      const previousBytes = Buffer.byteLength(JSON.stringify(results[index]), "utf8");
      let resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (
        "detail" in result &&
        replyBytes - previousBytes + resultBytes >
          MAX_PULL_REQUESTS_REPLY_BYTES - nodeIds.length * 4096
      ) {
        result = {
          nodeId: result.nodeId,
          error: "Detail batch reached its response limit. Retry this PR separately.",
        };
        resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      }
      results[index] = result;
      replyBytes += resultBytes - previousBytes;
    };
    let next = 0;
    const load = async () => {
      while (next < nodeIds.length) {
        const index = next++;
        const nodeId = nodeIds[index]!;
        try {
          controller.signal.throwIfAborted();
          const pr = pinned.prs.find((pr) => pr.nodeId === nodeId);
          if (!pr) throw new Error("Open pull request not found.");
          const captured = { headOid: pr.headOid, baseOid: pr.baseOid };
          const task = this.handlers!.detail(pinned.tabId, nodeId, captured, controller.signal);
          const detail = decode(
            PullRequestDetail,
            await new Promise<PullRequestDetail>((resolve, reject) => {
              const abort = () => reject(controller.signal.reason);
              controller.signal.addEventListener("abort", abort, { once: true });
              if (controller.signal.aborted) abort();
              void task
                .then(resolve, reject)
                .finally(() => controller.signal.removeEventListener("abort", abort));
            }),
          );
          controller.signal.throwIfAborted();
          const current = await this.snapshotByTab(pinned.tabId);
          await this.database.run(
            this.active(await this.database.run(this.owner(pinned.tabId, true))),
          );
          controller.signal.throwIfAborted();
          const currentPr = current.prs.find((pr) => pr.nodeId === nodeId);
          if (
            detail.headOid !== captured.headOid ||
            currentPr?.headOid !== captured.headOid ||
            currentPr.baseOid !== captured.baseOid
          )
            throw new Error(
              "Pull request changed while loading detail. Retry with its current commit.",
            );
          replace(index, { nodeId, captured, detail });
        } catch (error) {
          replace(index, {
            nodeId,
            error:
              error instanceof Error
                ? error.message.slice(0, 512)
                : "Pull request detail could not be loaded. Retry this PR separately.",
          });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, nodeIds.length) }, load));
      try {
        signal.throwIfAborted();
        const current = await this.snapshotByTab(pinned.tabId);
        await this.database.run(
          this.active(await this.database.run(this.owner(pinned.tabId, true))),
        );
        signal.throwIfAborted();
        for (const [index, result] of results.entries()) {
          if (!("detail" in result)) continue;
          const pr = current.prs.find((pr) => pr.nodeId === result.nodeId);
          if (pr?.headOid !== result.captured.headOid || pr.baseOid !== result.captured.baseOid)
            replace(index, {
              nodeId: result.nodeId,
              error: "Pull request changed while loading detail. Retry with its current commit.",
            });
        }
      } catch (error) {
        for (const [index, result] of results.entries())
          if ("detail" in result)
            replace(index, {
              nodeId: result.nodeId,
              error:
                error instanceof Error
                  ? error.message.slice(0, 512)
                  : "Pull request tab is no longer available.",
            });
      }
      return decode(PullRequestsReply, reply());
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }

  async command(value: PullRequestsCommand): Promise<PullRequestsReply> {
    const command = decode(PullRequestsCommand, value);
    if (command.action !== "detail" && command.action !== "details")
      return this.executeCommand(command);
    const controller = new AbortController();
    this.reads.set(controller, { tabId: command.tabId, requestId: command.requestId });
    try {
      return await this.executeCommand(command, controller.signal);
    } finally {
      this.reads.delete(controller);
    }
  }

  private async executeCommand(
    command: PullRequestsCommand,
    signal?: AbortSignal,
  ): Promise<PullRequestsReply> {
    if (command.action === "read")
      return { type: "snapshot", snapshot: await this.snapshot(command.name) };
    if (command.action === "sync" || command.action === "detail" || command.action === "details") {
      const owner = this.owner.bind(this),
        active = this.active.bind(this),
        read = this.read.bind(this);
      const pinned = await this.database.run(
        this.database.sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* owner(command.name);
            if (current.tab_id !== command.tabId)
              return yield* Effect.fail(
                new ScopeError(
                  409,
                  "This command belongs to a previous tab. Read the current snapshot before retrying.",
                ),
              );
            yield* active(current);
            return yield* read(current);
          }),
        ),
      );
      if (!pinned.repository)
        throw new ScopeError(409, "Configure a repository before synchronizing.");
      if (!this.handlers) throw new ScopeError(503, "Pull request synchronization is unavailable.");
      if (command.action === "sync")
        return decode(PullRequestsReply, {
          type: "snapshot",
          snapshot: await this.handlers.sync(pinned.tabId),
        });
      signal!.throwIfAborted();
      if (command.action === "details") return this.details(pinned, command.nodeIds, signal!);
      const pr = pinned.prs.find((pr) => pr.nodeId === command.nodeId);
      if (!pr) throw new ScopeError(404, "Open pull request not found.");
      if (
        command.captured &&
        (command.captured.headOid !== pr.headOid || command.captured.baseOid !== pr.baseOid)
      )
        throw new ScopeError(
          409,
          "This comparison changed. Load the latest comparison to view its details.",
        );
      const detail = decode(
        PullRequestDetail,
        await this.handlers.detail(pinned.tabId, pr.nodeId, command.captured, signal),
      );
      signal!.throwIfAborted();
      const current = await this.snapshotByTab(pinned.tabId);
      await this.database.run(this.active(await this.database.run(this.owner(pinned.tabId, true))));
      if (
        detail.headOid !== pr.headOid ||
        current.prs.find((row) => row.nodeId === pr.nodeId)?.headOid !== detail.headOid ||
        current.prs.find((row) => row.nodeId === pr.nodeId)?.baseOid !== pr.baseOid
      )
        throw new ScopeError(
          409,
          "Pull request changed while loading detail. Retry with its current commit.",
        );
      return { type: "detail", tabId: pinned.tabId, nodeId: pr.nodeId, detail };
    }
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      active = this.active.bind(this),
      read = this.read.bind(this);
    const payload = createHash("sha256")
      .update(
        JSON.stringify(command, (_key, value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      )
      .digest("hex");
    const result = await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(command.name);
          if (current.tab_id !== command.tabId)
            return yield* Effect.fail(
              new ScopeError(
                409,
                "This command belongs to a previous tab. Read the current snapshot before retrying.",
              ),
            );
          yield* active(current);
          const tabId = current.tab_id;
          const [receipt] = yield* sql<{
            payload: string;
          }>`SELECT payload FROM pull_requests_receipts WHERE tab_id = ${tabId} AND request_id = ${command.requestId}`;
          if (receipt) {
            if (receipt.payload !== payload)
              return yield* Effect.fail(
                new ScopeError(409, "This request ID was already used with different content."),
              );
            return { snapshot: yield* read(current), changed: false };
          }
          if (command.action === "configure") {
            const existing = current.repository
              ? decode(PullRequestsRepository, JSON.parse(current.repository))
              : null;
            const same =
              existing &&
              existing.owner.toLowerCase() === command.repository.owner.toLowerCase() &&
              existing.name.toLowerCase() === command.repository.name.toLowerCase();
            if (existing && !same)
              return yield* Effect.fail(
                new ScopeError(
                  409,
                  "This tab is bound to a repository. Publish another tab to use a different repository.",
                ),
              );
            if (!same)
              yield* sql`UPDATE pull_requests_state SET repository = ${JSON.stringify(command.repository)}, viewer = NULL, sync = ${JSON.stringify(emptySync)} WHERE tab_id = ${tabId}`;
          } else if (
            command.action === "state-set" ||
            command.action === "state-patch" ||
            command.action === "state-delete"
          ) {
            const saved = decode(PullRequestsAppState, JSON.parse(current.app_state));
            if (saved.version !== command.expectedVersion)
              return yield* Effect.fail(
                new ScopeError(
                  409,
                  "Inbox app state changed. Read the current state before saving.",
                ),
              );
            const value =
              command.action === "state-set" ? { ...command.value } : { ...saved.value };
            if (command.action === "state-patch") {
              for (const [key, item] of Object.entries(command.value))
                Object.defineProperty(value, key, {
                  value: item,
                  enumerable: true,
                  writable: true,
                  configurable: true,
                });
            }
            if (command.action === "state-delete")
              for (const key of command.keys) delete value[key];
            const appState = decode(PullRequestsAppState, { version: saved.version + 1, value });
            yield* sql`UPDATE pull_requests_state SET app_state = ${JSON.stringify(appState)} WHERE tab_id = ${tabId}`;
          } else {
            const [row] = yield* sql<{
              facts: string;
              local: string;
              agent: string;
            }>`SELECT facts, local, agent FROM pull_requests_current WHERE tab_id = ${tabId} AND node_id = ${command.nodeId}`;
            if (!row)
              return yield* Effect.fail(new ScopeError(404, "Open pull request not found."));
            const facts = decode(PullRequestFacts, JSON.parse(row.facts));
            const local = { ...decode(PullRequestLocal, JSON.parse(row.local)) };
            const agent = decode(PullRequestAgent, JSON.parse(row.agent));
            const version =
              command.action === "assessment"
                ? agent.version
                : command.action === "note"
                  ? local.noteVersion
                  : command.action === "snooze"
                    ? local.snoozeVersion
                    : local.reviewVersion;
            if (version !== command.expectedVersion)
              return yield* Effect.fail(
                new ScopeError(409, "This value changed. Read the current snapshot before saving."),
              );
            switch (command.action) {
              case "note":
                local.note = command.text;
                local.noteVersion++;
                break;
              case "snooze":
                if (command.snooze && command.snooze.headOid !== facts.headOid)
                  return yield* Effect.fail(
                    new ScopeError(
                      409,
                      "Pull request commit changed. Read the current snapshot before snoozing.",
                    ),
                  );
                local.snooze = command.snooze;
                local.snoozeVersion++;
                break;
              case "review":
                local[command.baseline] = {
                  headOid: command.headOid,
                  at: new Date().toISOString(),
                };
                local.reviewVersion++;
                break;
              case "assessment": {
                if (
                  new Set(command.customFields.map((field) => field.key)).size !==
                  command.customFields.length
                )
                  return yield* Effect.fail(
                    new ScopeError(400, "Custom field keys must be distinct."),
                  );
                yield* sql`UPDATE pull_requests_current SET agent = ${JSON.stringify({ version: agent.version + 1, assessment: command.assessment, customFields: command.customFields })} WHERE tab_id = ${tabId} AND node_id = ${command.nodeId}`;
                break;
              }
            }
            if (command.action !== "assessment")
              yield* sql`UPDATE pull_requests_current SET local = ${JSON.stringify(local)} WHERE tab_id = ${tabId} AND node_id = ${command.nodeId}`;
          }
          yield* sql`UPDATE pull_requests_state SET generation = generation + 1 WHERE tab_id = ${tabId}`;
          const updated = yield* owner(tabId, true);
          yield* sql`INSERT INTO pull_requests_receipts(tab_id, request_id, node_id, payload) VALUES (${tabId}, ${command.requestId}, ${"nodeId" in command ? command.nodeId : null}, ${payload})`;
          return { snapshot: yield* read(updated), changed: true };
        }),
      ),
      (result) => {
        if (!result.changed) return [];
        const operation =
          command.action === "state-set"
            ? "set"
            : command.action === "state-patch"
              ? "patch"
              : command.action === "state-delete"
                ? "delete"
                : undefined;
        return this.event(
          result.snapshot,
          operation ? { operation, ...result.snapshot.appState! } : undefined,
        );
      },
    );
    return { type: "snapshot", snapshot: result.snapshot };
  }
}
