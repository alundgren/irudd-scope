import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, ScopeError, decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  MAX_WORKSPACE_REPLY_BYTES,
  WorkspaceAppState,
  WorkspaceBoard,
  WorkspaceBoardRef,
  WorkspaceCommand,
  WorkspaceIssueFacts,
  WorkspaceMilestone,
  WorkspaceNodeAgent,
  WorkspaceNodeAppState,
  WorkspaceNodeLocal,
  WorkspacePullRequestFacts,
  WorkspaceReply,
  WorkspaceRepository,
  WorkspaceSnapshot,
  WorkspaceSyncStatus,
  WorkspaceTransition,
  type WorkspaceCommitPair,
  type WorkspaceIssueDetail,
  type WorkspacePullRequestDetail,
  type WorkspacePullRequestDetailResult,
  type WorkspaceNodeStateChange,
  type WorkspaceStateChange,
} from "@irudd-scope/protocol/workspace";
import {
  computeWorkspaceTransitions,
  retainWorkspaceEntities,
  trimTransitions,
} from "./workspace-diff.ts";

export const WORKSPACE_SCHEMA_VERSION = 21;

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
  board_ref: string | null;
  viewer: string | null;
  sync: string;
  board: string | null;
  last_issue_updated_at: string | null;
  app_state: string;
};

const emptySync: WorkspaceSyncStatus = {
  state: "idle",
  updatedAt: null,
  lastSuccessAt: null,
  error: null,
};
const emptyLocal: WorkspaceNodeLocal = {
  note: "",
  noteVersion: 0,
  snooze: null,
  snoozeVersion: 0,
  inspected: null,
  reviewed: null,
  reviewVersion: 0,
};
const emptyAgent: WorkspaceNodeAgent = { version: 0, assessment: null, customFields: [] };
const emptyAppState: WorkspaceAppState = { version: 0, value: {} };

export type WorkspaceHandlers = {
  sync: (tabId: string) => Promise<WorkspaceSnapshot>;
  prDetail: (
    tabId: string,
    nodeId: string,
    captured?: WorkspaceCommitPair,
    signal?: AbortSignal,
  ) => Promise<WorkspacePullRequestDetail>;
  issueDetail: (
    tabId: string,
    nodeId: string,
    signal?: AbortSignal,
  ) => Promise<WorkspaceIssueDetail>;
};

export type WorkspaceSyncCommit = {
  repository: WorkspaceRepository;
  boardRef: WorkspaceBoardRef | null;
  viewer: string | null;
  milestones: readonly WorkspaceMilestone[];
  issues: readonly WorkspaceIssueFacts[];
  prs: readonly WorkspacePullRequestFacts[];
  board: WorkspaceBoard | null;
  lastIssueUpdatedAt: string | null;
  completedAt: string;
  boardError?: string | null;
  syncOverride?: WorkspaceSyncStatus;
};

export function initializeWorkspaceTab(
  sql: SqliteClient.SqliteClient,
  tabId: string,
  artifact: Artifact,
) {
  if (artifact.kind !== "workspace") return Effect.void;
  return sql`INSERT INTO workspace_state(tab_id, generation, repository, board_ref, viewer, sync, board, last_issue_updated_at, app_state)
    VALUES (${tabId}, 0, NULL, NULL, NULL, ${JSON.stringify(emptySync)}, NULL, NULL, ${JSON.stringify(emptyAppState)})
    ON CONFLICT(tab_id) DO NOTHING`;
}

function receiptHash(command: WorkspaceCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function applyJsonEdit(
  current: Record<string, unknown>,
  action: "set" | "patch" | "delete",
  payload: Record<string, unknown> | readonly string[],
): Record<string, unknown> {
  if (action === "set") return { ...(payload as Record<string, unknown>) };
  if (action === "patch") return { ...current, ...(payload as Record<string, unknown>) };
  const next = { ...current };
  for (const key of payload as readonly string[]) delete next[key];
  return next;
}

export class WorkspaceStore {
  private handlers: WorkspaceHandlers | undefined;
  private readonly reads = new Map<AbortController, { tabId: string; requestId: string }>();

  constructor(private readonly database: Database) {}

  setHandlers(handlers: WorkspaceHandlers | undefined): void {
    this.handlers = handlers;
  }

  cancelReads(tabId?: string, requestIds?: readonly string[]): void {
    for (const [controller, read] of this.reads)
      if ((!tabId || read.tabId === tabId) && (!requestIds || requestIds.includes(read.requestId)))
        controller.abort(new Error("Workspace detail loading was canceled. Retry when ready."));
  }

  async initialize(): Promise<void> {
    const { sql, run } = this.database;
    const [{ user_version }] = await run(sql<{ user_version: number }>`PRAGMA user_version`);
    if (user_version >= WORKSPACE_SCHEMA_VERSION) return;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_state(
            tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE,
            generation INTEGER NOT NULL CHECK(generation >= 0),
            repository TEXT CHECK(repository IS NULL OR json_valid(repository)),
            board_ref TEXT CHECK(board_ref IS NULL OR json_valid(board_ref)),
            viewer TEXT,
            sync TEXT NOT NULL CHECK(json_valid(sync)),
            board TEXT CHECK(board IS NULL OR json_valid(board)),
            last_issue_updated_at TEXT,
            app_state TEXT NOT NULL DEFAULT '{"version":0,"value":{}}' CHECK(json_valid(app_state))
          ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_milestones(
            tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            facts TEXT NOT NULL CHECK(json_valid(facts)),
            PRIMARY KEY(tab_id, node_id)
          ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_issues(
            tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            facts TEXT NOT NULL CHECK(json_valid(facts)),
            local TEXT NOT NULL CHECK(json_valid(local)),
            agent TEXT NOT NULL CHECK(json_valid(agent)),
            PRIMARY KEY(tab_id, node_id)
          ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_prs(
            tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            facts TEXT NOT NULL CHECK(json_valid(facts)),
            local TEXT NOT NULL CHECK(json_valid(local)),
            agent TEXT NOT NULL CHECK(json_valid(agent)),
            PRIMARY KEY(tab_id, node_id)
          ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_node_state(
            tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(json_valid(state)),
            PRIMARY KEY(tab_id, node_id)
          ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_transitions(
            tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            at TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(tab_id, id)
          ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS workspace_receipts(
            tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY(tab_id, request_id)
          ) STRICT`;
          const existing = yield* sql<{
            tab_id: string;
            document: string;
          }>`SELECT tab_id, document FROM artifacts WHERE json_extract(document, '$.kind') = 'workspace'`;
          for (const row of existing)
            yield* initializeWorkspaceTab(
              sql,
              row.tab_id,
              decode(Artifact, JSON.parse(row.document)),
            );
          yield* sql`PRAGMA user_version = ${sql.literal(String(WORKSPACE_SCHEMA_VERSION))}`;
        }),
      ),
    );
  }

  async recoverInterruptedSync(): Promise<void> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const updatedAt = new Date().toISOString();
    await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const changed = yield* sql<{ tab_id: string }>`
            UPDATE workspace_state
            SET sync = json_set(sync, '$.state', 'error', '$.updatedAt', ${updatedAt}, '$.error', 'GitHub refresh was interrupted. Try Sync again.'),
                generation = generation + 1
            WHERE json_extract(sync, '$.state') = 'syncing'
            RETURNING tab_id`;
          const snapshots: WorkspaceSnapshot[] = [];
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
      const rows = byTab
        ? yield* sql<Owner>`
            SELECT artifacts.tab_id, artifacts.document, live_tabs.trashed_at, state.generation,
                   state.repository, state.board_ref, state.viewer, state.sync, state.board,
                   state.last_issue_updated_at, state.app_state
            FROM artifacts
            JOIN live_tabs ON live_tabs.id = artifacts.tab_id
            JOIN workspace_state AS state ON state.tab_id = artifacts.tab_id
            WHERE artifacts.tab_id = ${key} AND json_extract(artifacts.document, '$.kind') = 'workspace'`
        : yield* sql<Owner>`
            SELECT artifacts.tab_id, artifacts.document, live_tabs.trashed_at, state.generation,
                   state.repository, state.board_ref, state.viewer, state.sync, state.board,
                   state.last_issue_updated_at, state.app_state
            FROM artifacts
            JOIN live_tabs ON live_tabs.id = artifacts.tab_id
            JOIN workspace_state AS state ON state.tab_id = artifacts.tab_id
            WHERE json_extract(artifacts.document, '$.name') = ${key} AND json_extract(artifacts.document, '$.kind') = 'workspace'`;
      if (!rows[0]) return yield* Effect.fail(new ScopeError(404, "Workspace tab not found."));
      if (rows[0].trashed_at !== null)
        return yield* Effect.fail(
          new ScopeError(409, "This workspace tab is in Trashcan. Restore it before using it."),
        );
      return rows[0];
    });
  }

  private read(owner: Owner) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const artifact = decode(Artifact, JSON.parse(owner.document));
      const milestoneRows = yield* sql<{ facts: string }>`
        SELECT facts FROM workspace_milestones WHERE tab_id = ${owner.tab_id}`;
      const issueRows = yield* sql<{ facts: string; local: string; agent: string }>`
        SELECT facts, local, agent FROM workspace_issues WHERE tab_id = ${owner.tab_id}`;
      const prRows = yield* sql<{ facts: string; local: string; agent: string }>`
        SELECT facts, local, agent FROM workspace_prs WHERE tab_id = ${owner.tab_id}`;
      const transitionRows = yield* sql<{ payload: string }>`
        SELECT payload FROM workspace_transitions WHERE tab_id = ${owner.tab_id} ORDER BY at DESC`;
      return decode(WorkspaceSnapshot, {
        artifact,
        tabId: owner.tab_id,
        generation: owner.generation,
        repository: owner.repository ? JSON.parse(owner.repository) : null,
        boardRef: owner.board_ref ? JSON.parse(owner.board_ref) : null,
        viewer: owner.viewer,
        sync: JSON.parse(owner.sync),
        milestones: milestoneRows.map((row) => JSON.parse(row.facts)),
        issues: issueRows.map((row) => ({
          ...JSON.parse(row.facts),
          local: JSON.parse(row.local),
          agent: JSON.parse(row.agent),
        })),
        prs: prRows.map((row) => ({
          ...JSON.parse(row.facts),
          local: JSON.parse(row.local),
          agent: JSON.parse(row.agent),
        })),
        board: owner.board ? JSON.parse(owner.board) : null,
        transitions: transitionRows.map((row) => JSON.parse(row.payload)),
        appState: JSON.parse(owner.app_state),
      });
    });
  }

  private event(
    snapshot: WorkspaceSnapshot,
    extra?: { stateChange?: WorkspaceStateChange; nodeStateChange?: WorkspaceNodeStateChange },
  ): LiveEvent[] {
    if (!snapshot.artifact.name) return [];
    return [
      {
        type: "workspace",
        name: snapshot.artifact.name,
        id: snapshot.artifact.id,
        generation: snapshot.generation,
        tabId: snapshot.tabId,
        ...(extra?.stateChange ? { stateChange: extra.stateChange } : {}),
        ...(extra?.nodeStateChange ? { nodeStateChange: extra.nodeStateChange } : {}),
      },
    ];
  }

  async configuredTabs(): Promise<
    readonly {
      tabId: string;
      repository: WorkspaceRepository;
      boardRef: WorkspaceBoardRef | null;
      viewer: string | null;
      lastIssueUpdatedAt: string | null;
      boardUpdatedAt: string | null;
      hasBase: boolean;
    }[]
  > {
    const { sql, run } = this.database;
    const rows = await run(sql<{
      tab_id: string;
      repository: string;
      board_ref: string | null;
      viewer: string | null;
      last_issue_updated_at: string | null;
      board_updated_at: string | null;
    }>`
      SELECT state.tab_id, state.repository, state.board_ref, state.viewer, state.last_issue_updated_at,
             json_extract(state.board, '$.updatedAt') AS board_updated_at
      FROM workspace_state AS state
      JOIN live_tabs ON live_tabs.id = state.tab_id
      JOIN artifacts ON artifacts.tab_id = state.tab_id
      WHERE live_tabs.trashed_at IS NULL
        AND json_extract(artifacts.document, '$.kind') = 'workspace'
        AND state.repository IS NOT NULL`);
    return rows.map((row) => ({
      tabId: row.tab_id,
      repository: decode(WorkspaceRepository, JSON.parse(row.repository)),
      boardRef: row.board_ref ? decode(WorkspaceBoardRef, JSON.parse(row.board_ref)) : null,
      viewer: row.viewer,
      lastIssueUpdatedAt: row.last_issue_updated_at,
      boardUpdatedAt: row.board_updated_at,
      hasBase: row.viewer !== null,
    }));
  }

  async snapshot(name: string): Promise<WorkspaceSnapshot> {
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    return this.database.run(
      Effect.gen(function* () {
        return yield* read(yield* owner(name, false));
      }),
    );
  }

  async snapshotByTab(tabId: string): Promise<WorkspaceSnapshot> {
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    return this.database.run(
      Effect.gen(function* () {
        return yield* read(yield* owner(tabId, true));
      }),
    );
  }

  async setSyncStatus(
    tabId: string,
    sync: WorkspaceSyncStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const valid = decode(WorkspaceSyncStatus, sync);
    await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(tabId, true);
          yield* sql`UPDATE workspace_state SET sync = ${JSON.stringify(valid)}, generation = generation + 1 WHERE tab_id = ${current.tab_id}`;
          return yield* read(yield* owner(tabId, true));
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  async commitSync(
    tabId: string,
    commit: WorkspaceSyncCommit,
    signal?: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    signal?.throwIfAborted();
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const nowMs = Date.parse(commit.completedAt) || Date.now();
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(tabId, true);
          const prevIssuesRows = yield* sql<{
            node_id: string;
            facts: string;
            local: string;
            agent: string;
          }>`
            SELECT node_id, facts, local, agent FROM workspace_issues WHERE tab_id = ${tabId}`;
          const prevPrsRows = yield* sql<{
            node_id: string;
            facts: string;
            local: string;
            agent: string;
          }>`
            SELECT node_id, facts, local, agent FROM workspace_prs WHERE tab_id = ${tabId}`;
          const prevTransRows = yield* sql<{ payload: string }>`
            SELECT payload FROM workspace_transitions WHERE tab_id = ${tabId} ORDER BY at DESC`;

          const prevIssuesMap = new Map(
            prevIssuesRows.map((r) => [
              r.node_id,
              {
                facts: decode(WorkspaceIssueFacts, JSON.parse(r.facts)),
                local: r.local,
                agent: r.agent,
              },
            ]),
          );
          const prevPrsMap = new Map(
            prevPrsRows.map((r) => [
              r.node_id,
              {
                facts: decode(WorkspacePullRequestFacts, JSON.parse(r.facts)),
                local: r.local,
                agent: r.agent,
              },
            ]),
          );
          const prevBoard = current.board
            ? decode(WorkspaceBoard, JSON.parse(current.board))
            : null;
          const prevTransitions = prevTransRows.map((r) =>
            decode(WorkspaceTransition, JSON.parse(r.payload)),
          );

          const retained = retainWorkspaceEntities({
            issues: commit.issues.map((i) => decode(WorkspaceIssueFacts, i)),
            prs: commit.prs.map((p) => decode(WorkspacePullRequestFacts, p)),
            milestones: commit.milestones.map((m) => decode(WorkspaceMilestone, m)),
            board: commit.board ? decode(WorkspaceBoard, commit.board) : null,
            nowMs,
          });
          const nextBoard = commit.board ? decode(WorkspaceBoard, commit.board) : null;
          const addedTransitions = computeWorkspaceTransitions(
            {
              hasBase: current.viewer !== null,
              issues: [...prevIssuesMap.values()].map((e) => e.facts),
              prs: [...prevPrsMap.values()].map((e) => e.facts),
              board: prevBoard,
            },
            { issues: retained.issues, prs: retained.prs, board: nextBoard },
            commit.completedAt,
          );
          const allTransitions = trimTransitions(prevTransitions, addedTransitions, nowMs);

          yield* sql`DELETE FROM workspace_milestones WHERE tab_id = ${tabId}`;
          for (const milestone of retained.milestones) {
            yield* sql`INSERT INTO workspace_milestones(tab_id, node_id, facts) VALUES (${tabId}, ${milestone.nodeId}, ${JSON.stringify(milestone)})`;
          }

          yield* sql`DELETE FROM workspace_issues WHERE tab_id = ${tabId}`;
          for (const issue of retained.issues) {
            const prev = prevIssuesMap.get(issue.nodeId);
            yield* sql`INSERT INTO workspace_issues(tab_id, node_id, facts, local, agent) VALUES (${tabId}, ${issue.nodeId}, ${JSON.stringify(issue)}, ${prev?.local ?? JSON.stringify(emptyLocal)}, ${prev?.agent ?? JSON.stringify(emptyAgent)})`;
          }

          yield* sql`DELETE FROM workspace_prs WHERE tab_id = ${tabId}`;
          for (const pr of retained.prs) {
            const prev = prevPrsMap.get(pr.nodeId);
            yield* sql`INSERT INTO workspace_prs(tab_id, node_id, facts, local, agent) VALUES (${tabId}, ${pr.nodeId}, ${JSON.stringify(pr)}, ${prev?.local ?? JSON.stringify(emptyLocal)}, ${prev?.agent ?? JSON.stringify(emptyAgent)})`;
          }

          const liveNodeIds = new Set<string>([
            ...retained.issues.map((i) => i.nodeId),
            ...retained.prs.map((p) => p.nodeId),
            ...(nextBoard?.items.map((item) => item.contentNodeId ?? item.itemId) ?? []),
          ]);
          const nodeStateRows = yield* sql<{ node_id: string }>`
            SELECT node_id FROM workspace_node_state WHERE tab_id = ${tabId}`;
          for (const row of nodeStateRows) {
            if (!liveNodeIds.has(row.node_id)) {
              yield* sql`DELETE FROM workspace_node_state WHERE tab_id = ${tabId} AND node_id = ${row.node_id}`;
            }
          }

          yield* sql`DELETE FROM workspace_transitions WHERE tab_id = ${tabId}`;
          for (const item of allTransitions) {
            yield* sql`INSERT INTO workspace_transitions(tab_id, id, at, payload) VALUES (${tabId}, ${item.id}, ${item.at}, ${JSON.stringify(item)})`;
          }

          const prevSync = decode(WorkspaceSyncStatus, JSON.parse(current.sync));
          const nextSync: WorkspaceSyncStatus = commit.syncOverride ?? {
            ...prevSync,
            state: "idle",
            updatedAt: commit.completedAt,
            lastSuccessAt: commit.completedAt,
            error: null,
            boardError: commit.boardError ?? null,
          };

          yield* sql`UPDATE workspace_state
            SET generation = generation + 1,
                repository = ${JSON.stringify(commit.repository)},
                board_ref = ${commit.boardRef ? JSON.stringify(commit.boardRef) : null},
                viewer = ${commit.viewer},
                sync = ${JSON.stringify(nextSync)},
                board = ${nextBoard ? JSON.stringify(nextBoard) : null},
                last_issue_updated_at = ${commit.lastIssueUpdatedAt}
            WHERE tab_id = ${tabId}`;

          return yield* read(yield* owner(tabId, true));
        }),
      ),
      (snapshot) => this.event(snapshot),
    );
  }

  async command(input: WorkspaceCommand): Promise<WorkspaceReply> {
    const command = decode(WorkspaceCommand, input);
    if (command.action === "read") {
      return { type: "snapshot", snapshot: await this.snapshot(command.name) };
    }
    if (command.action === "sync") {
      if (!this.handlers)
        throw new ScopeError(503, "Workspace synchronization is not available right now.");
      const current = await this.snapshot(command.name);
      if (current.tabId !== command.tabId)
        throw new ScopeError(409, "Workspace tab identity changed. Read the current snapshot.");
      return { type: "snapshot", snapshot: await this.handlers.sync(command.tabId) };
    }
    if (command.action === "pr-detail") return this.handlePrDetail(command);
    if (command.action === "pr-details") return this.handlePrDetails(command);
    if (command.action === "issue-detail") return this.handleIssueDetail(command);
    if (command.action === "node-state-read") return this.handleNodeStateRead(command);
    if (command.action === "configure") return this.handleConfigure(command);
    if (
      command.action === "state-set" ||
      command.action === "state-patch" ||
      command.action === "state-delete"
    )
      return this.handleAppState(command);
    if (
      command.action === "node-state-set" ||
      command.action === "node-state-patch" ||
      command.action === "node-state-delete"
    )
      return this.handleNodeStateWrite(command);
    return this.handleNodeLocalWrite(command);
  }

  private async runRead<T>(
    tabId: string,
    requestId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.reads.set(controller, { tabId, requestId });
    try {
      return await work(controller.signal);
    } finally {
      this.reads.delete(controller);
    }
  }

  private async handlePrDetail(
    command: Extract<WorkspaceCommand, { action: "pr-detail" }>,
  ): Promise<WorkspaceReply> {
    if (!this.handlers) throw new ScopeError(503, "Workspace synchronization is not available.");
    const current = await this.snapshot(command.name);
    if (current.tabId !== command.tabId) throw new ScopeError(409, "Workspace tab changed.");
    const detail = await this.runRead(command.tabId, command.requestId, (signal) =>
      this.handlers!.prDetail(command.tabId, command.nodeId, command.captured, signal),
    );
    return { type: "pr-detail", tabId: command.tabId, nodeId: command.nodeId, detail };
  }

  private async handlePrDetails(
    command: Extract<WorkspaceCommand, { action: "pr-details" }>,
  ): Promise<WorkspaceReply> {
    if (!this.handlers) throw new ScopeError(503, "Workspace synchronization is not available.");
    const current = await this.snapshot(command.name);
    if (current.tabId !== command.tabId) throw new ScopeError(409, "Workspace tab changed.");
    const results: WorkspacePullRequestDetailResult[] = [];
    let totalBytes = 0;
    await this.runRead(command.tabId, command.requestId, async (signal) => {
      for (const nodeId of command.nodeIds) {
        signal.throwIfAborted();
        const pr = current.prs.find((row) => row.nodeId === nodeId);
        if (!pr || !pr.headOid || !pr.baseOid) {
          results.push({ nodeId, error: "Pull request not found or missing commits." });
          continue;
        }
        try {
          const captured = { headOid: pr.headOid, baseOid: pr.baseOid };
          const detail = await this.handlers!.prDetail(command.tabId, nodeId, captured, signal);
          const bytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
          if (totalBytes + bytes > MAX_WORKSPACE_REPLY_BYTES - 1024 * 1024) {
            results.push({ nodeId, error: "Detail batch reached response size limit." });
            continue;
          }
          totalBytes += bytes;
          results.push({ nodeId, captured, detail });
        } catch (error) {
          results.push({
            nodeId,
            error: error instanceof Error ? error.message : "Could not load pull request detail.",
          });
        }
      }
    });
    return { type: "pr-details", tabId: command.tabId, results };
  }

  private async handleIssueDetail(
    command: Extract<WorkspaceCommand, { action: "issue-detail" }>,
  ): Promise<WorkspaceReply> {
    if (!this.handlers) throw new ScopeError(503, "Workspace synchronization is not available.");
    const current = await this.snapshot(command.name);
    if (current.tabId !== command.tabId) throw new ScopeError(409, "Workspace tab changed.");
    const detail = await this.runRead(command.tabId, command.requestId, (signal) =>
      this.handlers!.issueDetail(command.tabId, command.nodeId, signal),
    );
    return { type: "issue-detail", tabId: command.tabId, nodeId: command.nodeId, detail };
  }

  private async handleConfigure(
    command: Extract<WorkspaceCommand, { action: "configure" }>,
  ): Promise<WorkspaceReply> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const hash = receiptHash(command);
    const snapshot = await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(command.name, false);
          if (current.tab_id !== command.tabId)
            return yield* Effect.fail(new ScopeError(409, "Workspace tab identity changed."));
          const existing = yield* sql<{ payload: string }>`
            SELECT payload FROM workspace_receipts WHERE tab_id = ${current.tab_id} AND request_id = ${command.requestId}`;
          if (existing[0]) {
            if (existing[0].payload !== hash)
              return yield* Effect.fail(
                new ScopeError(409, "Request ID was reused with different input."),
              );
            return yield* read(current);
          }
          const prevRepo = current.repository
            ? decode(WorkspaceRepository, JSON.parse(current.repository))
            : null;
          const repoChanged =
            !prevRepo ||
            prevRepo.owner.toLowerCase() !== command.repository.owner.toLowerCase() ||
            prevRepo.name.toLowerCase() !== command.repository.name.toLowerCase();
          const nextBoardRef =
            command.board === undefined
              ? current.board_ref
                ? JSON.parse(current.board_ref)
                : null
              : command.board;
          if (repoChanged) {
            yield* sql`DELETE FROM workspace_milestones WHERE tab_id = ${current.tab_id}`;
            yield* sql`DELETE FROM workspace_issues WHERE tab_id = ${current.tab_id}`;
            yield* sql`DELETE FROM workspace_prs WHERE tab_id = ${current.tab_id}`;
            yield* sql`DELETE FROM workspace_transitions WHERE tab_id = ${current.tab_id}`;
            yield* sql`DELETE FROM workspace_node_state WHERE tab_id = ${current.tab_id}`;
          }
          const boardCleared = nextBoardRef === null || repoChanged;
          yield* sql`UPDATE workspace_state
            SET repository = ${JSON.stringify(command.repository)},
                board_ref = ${nextBoardRef ? JSON.stringify(nextBoardRef) : null},
                board = ${boardCleared ? null : current.board},
                viewer = ${repoChanged ? null : current.viewer},
                last_issue_updated_at = ${repoChanged ? null : current.last_issue_updated_at},
                sync = ${JSON.stringify(emptySync)},
                generation = generation + 1
            WHERE tab_id = ${current.tab_id}`;
          yield* sql`INSERT INTO workspace_receipts(tab_id, request_id, payload) VALUES (${current.tab_id}, ${command.requestId}, ${hash})`;
          return yield* read(yield* owner(current.tab_id, true));
        }),
      ),
      (snap) => this.event(snap),
    );
    return { type: "snapshot", snapshot };
  }

  private async handleAppState(
    command: Extract<WorkspaceCommand, { action: "state-set" | "state-patch" | "state-delete" }>,
  ): Promise<WorkspaceReply> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const hash = receiptHash(command);
    const op =
      command.action === "state-set"
        ? "set"
        : command.action === "state-patch"
          ? "patch"
          : "delete";
    const result = await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(command.name, false);
          if (current.tab_id !== command.tabId)
            return yield* Effect.fail(new ScopeError(409, "Workspace tab identity changed."));
          const existing = yield* sql<{ payload: string }>`
            SELECT payload FROM workspace_receipts WHERE tab_id = ${current.tab_id} AND request_id = ${command.requestId}`;
          if (existing[0]) {
            if (existing[0].payload !== hash)
              return yield* Effect.fail(
                new ScopeError(409, "Request ID was reused with different input."),
              );
            return { snapshot: yield* read(current), change: undefined };
          }
          const state = decode(WorkspaceAppState, JSON.parse(current.app_state));
          if (state.version !== command.expectedVersion)
            return yield* Effect.fail(
              new ScopeError(
                409,
                "Workspace app state changed. Read the current state before saving.",
              ),
            );
          const nextValue = applyJsonEdit(
            state.value,
            op,
            command.action === "state-delete" ? command.keys : command.value,
          );
          const nextState = decode(WorkspaceAppState, {
            version: state.version + 1,
            value: nextValue,
          });
          yield* sql`UPDATE workspace_state SET app_state = ${JSON.stringify(nextState)}, generation = generation + 1 WHERE tab_id = ${current.tab_id}`;
          yield* sql`INSERT INTO workspace_receipts(tab_id, request_id, payload) VALUES (${current.tab_id}, ${command.requestId}, ${hash})`;
          const snapshot = yield* read(yield* owner(current.tab_id, true));
          return { snapshot, change: { operation: op, ...nextState } as WorkspaceStateChange };
        }),
      ),
      ({ snapshot, change }) => this.event(snapshot, change ? { stateChange: change } : undefined),
    );
    return { type: "snapshot", snapshot: result.snapshot };
  }

  private async handleNodeStateRead(
    command: Extract<WorkspaceCommand, { action: "node-state-read" }>,
  ): Promise<WorkspaceReply> {
    const { sql, run } = this.database;
    const owner = this.owner.bind(this);
    const state = await run(
      Effect.gen(function* () {
        const current = yield* owner(command.name, false);
        if (current.tab_id !== command.tabId)
          return yield* Effect.fail(new ScopeError(409, "Workspace tab identity changed."));
        const [row] = yield* sql<{ state: string }>`
          SELECT state FROM workspace_node_state WHERE tab_id = ${current.tab_id} AND node_id = ${command.nodeId}`;
        return row
          ? decode(WorkspaceNodeAppState, JSON.parse(row.state))
          : { version: 0, value: {} };
      }),
    );
    return { type: "node-state", tabId: command.tabId, nodeId: command.nodeId, state };
  }

  private async handleNodeStateWrite(
    command: Extract<
      WorkspaceCommand,
      { action: "node-state-set" | "node-state-patch" | "node-state-delete" }
    >,
  ): Promise<WorkspaceReply> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const hash = receiptHash(command);
    const op: "set" | "patch" | "delete" =
      command.action === "node-state-set"
        ? "set"
        : command.action === "node-state-patch"
          ? "patch"
          : "delete";
    const result = await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(command.name, false);
          if (current.tab_id !== command.tabId)
            return yield* Effect.fail(new ScopeError(409, "Workspace tab identity changed."));
          const existing = yield* sql<{ payload: string }>`
            SELECT payload FROM workspace_receipts WHERE tab_id = ${current.tab_id} AND request_id = ${command.requestId}`;
          const [row] = yield* sql<{ state: string }>`
            SELECT state FROM workspace_node_state WHERE tab_id = ${current.tab_id} AND node_id = ${command.nodeId}`;
          const state = row
            ? decode(WorkspaceNodeAppState, JSON.parse(row.state))
            : { version: 0, value: {} };
          if (existing[0]) {
            if (existing[0].payload !== hash)
              return yield* Effect.fail(
                new ScopeError(409, "Request ID was reused with different input."),
              );
            return { snapshot: yield* read(current), state, change: undefined };
          }
          if (state.version !== command.expectedVersion)
            return yield* Effect.fail(
              new ScopeError(409, "Node state changed. Read the current state before saving."),
            );
          const nextValue = applyJsonEdit(
            state.value,
            op,
            command.action === "node-state-delete" ? command.keys : command.value,
          );
          const nextState = decode(WorkspaceNodeAppState, {
            version: state.version + 1,
            value: nextValue,
          });
          yield* sql`INSERT INTO workspace_node_state(tab_id, node_id, state)
            VALUES (${current.tab_id}, ${command.nodeId}, ${JSON.stringify(nextState)})
            ON CONFLICT(tab_id, node_id) DO UPDATE SET state = excluded.state`;
          yield* sql`UPDATE workspace_state SET generation = generation + 1 WHERE tab_id = ${current.tab_id}`;
          yield* sql`INSERT INTO workspace_receipts(tab_id, request_id, payload) VALUES (${current.tab_id}, ${command.requestId}, ${hash})`;
          const snapshot = yield* read(yield* owner(current.tab_id, true));
          return {
            snapshot,
            state: nextState,
            change: { nodeId: command.nodeId, operation: op, version: nextState.version },
          };
        }),
      ),
      ({ snapshot, change }) =>
        this.event(snapshot, change ? { nodeStateChange: change } : undefined),
    );
    return {
      type: "node-state",
      tabId: command.tabId,
      nodeId: command.nodeId,
      state: result.state,
    };
  }

  private async handleNodeLocalWrite(
    command: Extract<WorkspaceCommand, { action: "note" | "snooze" | "review" | "assessment" }>,
  ): Promise<WorkspaceReply> {
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);
    const read = this.read.bind(this);
    const hash = receiptHash(command);
    const now = new Date().toISOString();
    const snapshot = await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* owner(command.name, false);
          if (current.tab_id !== command.tabId)
            return yield* Effect.fail(new ScopeError(409, "Workspace tab identity changed."));
          const existing = yield* sql<{ payload: string }>`
            SELECT payload FROM workspace_receipts WHERE tab_id = ${current.tab_id} AND request_id = ${command.requestId}`;
          if (existing[0]) {
            if (existing[0].payload !== hash)
              return yield* Effect.fail(
                new ScopeError(409, "Request ID was reused with different input."),
              );
            return yield* read(current);
          }
          const [prRow] = yield* sql<{ local: string; agent: string }>`
            SELECT local, agent FROM workspace_prs WHERE tab_id = ${current.tab_id} AND node_id = ${command.nodeId}`;
          const [issueRow] = prRow
            ? []
            : yield* sql<{ local: string; agent: string }>`
                SELECT local, agent FROM workspace_issues WHERE tab_id = ${current.tab_id} AND node_id = ${command.nodeId}`;
          const row = prRow ?? issueRow;
          if (!row) return yield* Effect.fail(new ScopeError(404, "Workspace item not found."));
          const table = prRow ? "workspace_prs" : "workspace_issues";
          let local = decode(WorkspaceNodeLocal, JSON.parse(row.local));
          let agent = decode(WorkspaceNodeAgent, JSON.parse(row.agent));

          if (command.action === "note") {
            if (local.noteVersion !== command.expectedVersion)
              return yield* Effect.fail(
                new ScopeError(409, "Note changed. Read the latest snapshot."),
              );
            local = { ...local, note: command.text, noteVersion: local.noteVersion + 1 };
          } else if (command.action === "snooze") {
            if (local.snoozeVersion !== command.expectedVersion)
              return yield* Effect.fail(
                new ScopeError(409, "Snooze changed. Read the latest snapshot."),
              );
            local = { ...local, snooze: command.snooze, snoozeVersion: local.snoozeVersion + 1 };
          } else if (command.action === "review") {
            if (local.reviewVersion !== command.expectedVersion)
              return yield* Effect.fail(
                new ScopeError(409, "Review baseline changed. Read the latest snapshot."),
              );
            const baseline = { headOid: command.headOid, at: now };
            local = {
              ...local,
              [command.baseline]: baseline,
              reviewVersion: local.reviewVersion + 1,
            };
          } else {
            if (agent.version !== command.expectedVersion)
              return yield* Effect.fail(
                new ScopeError(409, "Agent state changed. Read the latest snapshot."),
              );
            agent = {
              version: agent.version + 1,
              assessment: command.assessment,
              customFields: [...command.customFields],
            };
          }

          if (table === "workspace_prs") {
            yield* sql`UPDATE workspace_prs SET local = ${JSON.stringify(local)}, agent = ${JSON.stringify(agent)} WHERE tab_id = ${current.tab_id} AND node_id = ${command.nodeId}`;
          } else {
            yield* sql`UPDATE workspace_issues SET local = ${JSON.stringify(local)}, agent = ${JSON.stringify(agent)} WHERE tab_id = ${current.tab_id} AND node_id = ${command.nodeId}`;
          }
          yield* sql`UPDATE workspace_state SET generation = generation + 1 WHERE tab_id = ${current.tab_id}`;
          yield* sql`INSERT INTO workspace_receipts(tab_id, request_id, payload) VALUES (${current.tab_id}, ${command.requestId}, ${hash})`;
          return yield* read(yield* owner(current.tab_id, true));
        }),
      ),
      (snap) => this.event(snap),
    );
    return { type: "snapshot", snapshot };
  }
}
