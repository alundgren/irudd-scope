import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, ScopeError, decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  PullRequestsCommand,
  PullRequestsReply,
  PullRequestsSnapshot,
  PullRequestsSync,
  PullRequestsRepository,
  PullRequestFacts,
  PullRequestLocal,
  PullRequestAgent,
  PullRequestDetail,
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
  detail: (tabId: string, nodeId: string) => Promise<PullRequestDetail>;
};
export type PullRequestsInventory = {
  repository: PullRequestsRepository;
  viewer: string | null;
  prs: readonly PullRequestFacts[];
  completedAt: string;
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
  constructor(private readonly database: Database) {}
  setHandlers(handlers: PullRequestsHandlers | undefined): void {
    this.handlers = handlers;
  }

  async initialize(): Promise<void> {
    const { sql, run } = this.database;
    const [{ user_version }] = await run(sql<{ user_version: number }>`PRAGMA user_version`);
    if (user_version >= 7) return;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE pull_requests_state(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK(generation >= 0), repository TEXT CHECK(repository IS NULL OR json_valid(repository)), viewer TEXT, sync TEXT NOT NULL CHECK(json_valid(sync))) STRICT`;
          yield* sql`CREATE TABLE pull_requests_current(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, facts TEXT NOT NULL CHECK(json_valid(facts)), local TEXT NOT NULL CHECK(json_valid(local)), agent TEXT NOT NULL CHECK(json_valid(agent)), PRIMARY KEY(tab_id, node_id)) STRICT`;
          yield* sql`CREATE TABLE pull_requests_receipts(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, node_id TEXT, payload TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(tab_id, request_id), FOREIGN KEY(tab_id, node_id) REFERENCES pull_requests_current(tab_id, node_id) ON DELETE CASCADE) STRICT`;
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

  private owner(key: string, byTab = false) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const rows =
        yield* sql<Owner>`SELECT artifacts.tab_id, artifacts.document, live_tabs.trashed_at, pull_requests_state.generation, pull_requests_state.repository, pull_requests_state.viewer, pull_requests_state.sync FROM artifacts JOIN live_tabs ON live_tabs.id = artifacts.tab_id JOIN pull_requests_state ON pull_requests_state.tab_id = artifacts.tab_id WHERE ${byTab ? sql`artifacts.tab_id = ${key}` : sql`json_extract(artifacts.document, '$.name') = ${key}`} AND json_extract(artifacts.document, '$.kind') = 'pull-requests'`;
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
  private event(snapshot: PullRequestsSnapshot): LiveEvent[] {
    return [
      {
        type: "pull-requests",
        name: snapshot.artifact.name!,
        id: snapshot.artifact.id,
        generation: snapshot.generation,
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

  async setSyncStatus(tabId: string, value: PullRequestsSync): Promise<PullRequestsSnapshot> {
    const sync = decode(PullRequestsSync, value);
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this),
      active = this.active.bind(this),
      read = this.read.bind(this);
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* active(yield* owner(tabId, true));
          yield* sql`UPDATE pull_requests_state SET sync = ${JSON.stringify(sync)}, generation = generation + 1 WHERE tab_id = ${tabId}`;
          return yield* read(yield* owner(tabId, true));
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  async commitInventory(
    tabId: string,
    value: PullRequestsInventory,
  ): Promise<PullRequestsSnapshot> {
    const repository = decode(PullRequestsRepository, value.repository);
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
    const sync = decode(PullRequestsSync, {
      state: "idle",
      updatedAt: value.completedAt,
      lastSuccessAt: value.completedAt,
      error: null,
    });
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
          for (const pr of prs)
            yield* sql`INSERT INTO pull_requests_current(tab_id, node_id, facts, local, agent) VALUES (${tabId}, ${pr.nodeId}, ${JSON.stringify(pr)}, ${JSON.stringify(emptyLocal)}, ${JSON.stringify(emptyAgent)}) ON CONFLICT(tab_id, node_id) DO UPDATE SET facts = excluded.facts`;
          if (prs.length)
            yield* sql`DELETE FROM pull_requests_current WHERE tab_id = ${tabId} AND NOT ${sql.in(
              "node_id",
              prs.map((pr) => pr.nodeId),
            )}`;
          else yield* sql`DELETE FROM pull_requests_current WHERE tab_id = ${tabId}`;
          yield* sql`UPDATE pull_requests_state SET viewer = ${value.viewer}, sync = ${JSON.stringify(sync)}, generation = generation + 1 WHERE tab_id = ${tabId}`;
          return yield* read(yield* owner(tabId, true));
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  async command(value: PullRequestsCommand): Promise<PullRequestsReply> {
    const command = decode(PullRequestsCommand, value);
    if (command.action === "read")
      return { type: "snapshot", snapshot: await this.snapshot(command.name) };
    if (command.action === "sync" || command.action === "detail") {
      const pinned = await this.snapshot(command.name);
      await this.database.run(this.active(await this.database.run(this.owner(pinned.tabId, true))));
      if (!pinned.repository)
        throw new ScopeError(409, "Configure a repository before synchronizing.");
      if (!this.handlers) throw new ScopeError(503, "Pull request synchronization is unavailable.");
      if (command.action === "sync")
        return decode(PullRequestsReply, {
          type: "snapshot",
          snapshot: await this.handlers.sync(pinned.tabId),
        });
      const pr = pinned.prs.find((pr) => pr.nodeId === command.nodeId);
      if (!pr) throw new ScopeError(404, "Open pull request not found.");
      const detail = decode(PullRequestDetail, await this.handlers.detail(pinned.tabId, pr.nodeId));
      const current = await this.snapshotByTab(pinned.tabId);
      await this.database.run(this.active(await this.database.run(this.owner(pinned.tabId, true))));
      if (
        detail.headOid !== pr.headOid ||
        current.prs.find((row) => row.nodeId === pr.nodeId)?.headOid !== detail.headOid
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
                if (command.headOid !== facts.headOid)
                  return yield* Effect.fail(
                    new ScopeError(
                      409,
                      "Pull request commit changed. Read the current snapshot before marking it reviewed.",
                    ),
                  );
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
          yield* sql`INSERT INTO pull_requests_receipts(tab_id, request_id, node_id, payload, sequence) VALUES (${tabId}, ${command.requestId}, ${command.action === "configure" ? null : command.nodeId}, ${payload}, ${updated.generation})`;
          yield* sql`DELETE FROM pull_requests_receipts WHERE tab_id = ${tabId} AND request_id NOT IN (SELECT request_id FROM pull_requests_receipts WHERE tab_id = ${tabId} ORDER BY sequence DESC LIMIT 256)`;
          return { snapshot: yield* read(updated), changed: true };
        }),
      ),
      (result) => (result.changed ? this.event(result.snapshot) : []),
    );
    return { type: "snapshot", snapshot: result.snapshot };
  }
}
