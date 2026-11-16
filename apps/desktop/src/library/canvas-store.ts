import { createHash, randomInt } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  BoardCard,
  CANVAS_TAB_TYPE,
  MAX_BOARD_CARDS,
  MAX_CARD_BYTES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  targetScope,
  type CanvasActor,
  type CanvasChange,
  type CanvasHistoryState,
  type CanvasOp,
  type CanvasSnapshot,
  type CanvasStep,
  type CanvasTarget,
  type CanvasWriteResult,
  type CanvasWritten,
  type CardContent,
} from "../plugins/canvas/contract.ts";
import {
  ChangeError,
  applyOps,
  combineInverses,
  guardedInverse,
  historyStacks,
  overlap,
  resolveRefs,
  touches,
  type HistoryRow,
} from "../plugins/canvas/changes.ts";
import { findCardType } from "../plugins/canvas/cards/registry.ts";

type Database = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  mutate: <A, E>(effect: Effect.Effect<A, E>, events: (result: A) => LiveEvent[]) => Promise<A>;
};
type Sql = SqliteClient.SqliteClient;
type Target = { content: CardContent; version: number; type?: string };
type Planned =
  | Extract<CanvasWriteResult, { ok: false }>
  | {
      commit: Commit;
      refs: Record<string, string>;
      replayedOver: number[];
      kept: CanvasWritten["kept"];
      warnings?: string[];
    };

/** Runs code that throws ChangeError as a typed failure, so the transaction rolls back. */
const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof ChangeError
        ? error
        : new ChangeError(error instanceof Error ? error.message : "The change is not valid."),
  });
type Commit = {
  tabId: string;
  target: CanvasTarget;
  requestId: string;
  hash: string;
  actor: CanvasActor;
  kind: HistoryRow["kind"];
  undoes: number | null;
  turnId: string | null;
  label: string;
  ops: CanvasOp[];
};

export const CANVAS_SCHEMA_VERSION = 19;
const ID_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const refused = (code: Extract<CanvasWriteResult, { ok: false }>["code"], message: string) =>
  ({ ok: false, code, message }) as const;

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}

/** Creates the canvas tables. Every row goes away with its tab. */
export function createCanvasTables(sql: Sql) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_boards (tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version >= 0), document TEXT NOT NULL CHECK(json_valid(document))) STRICT`;
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_cards (tab_id TEXT NOT NULL REFERENCES canvas_boards(tab_id) ON DELETE CASCADE, card_id TEXT NOT NULL, type TEXT NOT NULL, type_version INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version >= 0), content TEXT NOT NULL CHECK(json_valid(content)), deleted_at INTEGER, PRIMARY KEY(tab_id, card_id)) STRICT`;
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_history (tab_id TEXT NOT NULL REFERENCES canvas_boards(tab_id) ON DELETE CASCADE, scope TEXT NOT NULL, seq INTEGER NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, actor TEXT NOT NULL CHECK(actor IN ('person', 'agent')), kind TEXT NOT NULL CHECK(kind IN ('do', 'undo', 'redo')), undoes INTEGER, turn_id TEXT, label TEXT NOT NULL, ops TEXT NOT NULL CHECK(json_valid(ops)), inverse TEXT NOT NULL CHECK(json_valid(inverse)), result TEXT NOT NULL CHECK(json_valid(result)), bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tab_id, scope, seq), UNIQUE(tab_id, request_id)) STRICT`;
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_ids (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, scope TEXT) STRICT`;
      yield* sql`CREATE TABLE IF NOT EXISTS canvas_requests (tab_id TEXT NOT NULL REFERENCES canvas_boards(tab_id) ON DELETE CASCADE, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), created_at INTEGER NOT NULL, PRIMARY KEY(tab_id, request_id)) STRICT`;
      yield* sql`CREATE INDEX IF NOT EXISTS canvas_ids_tab ON canvas_ids(tab_id)`;
      const [{ user_version }] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
      if (user_version < CANVAS_SCHEMA_VERSION)
        yield* sql`PRAGMA user_version = ${sql.literal(String(CANVAS_SCHEMA_VERSION))}`;
    }),
  );
}

/** Makes IDs that no other row in scope.db has used, and records them for the tab. */
/** How long a change's receipt answers retries of its request ID. */
const RECEIPT_DAYS = 30;

function newIds(sql: Sql, tabId: string, count: number) {
  return Effect.gen(function* () {
    const ids: string[] = [];
    while (ids.length < count) {
      const id = Array.from({ length: 8 }, () => ID_CHARACTERS[randomInt(36)]).join("");
      const rows =
        yield* sql`INSERT INTO canvas_ids(id, tab_id) VALUES (${id}, ${tabId}) ON CONFLICT(id) DO NOTHING RETURNING id`;
      if (rows.length) ids.push(id);
    }
    return ids;
  });
}

function ensureBoard(sql: Sql, tabId: string) {
  return Effect.gen(function* () {
    const [tab] = yield* sql<{
      type: string | null;
    }>`SELECT json_extract(document, '$.type') AS type FROM live_tabs WHERE id = ${tabId}`;
    if (tab?.type !== CANVAS_TAB_TYPE) return false;
    yield* sql`INSERT INTO canvas_boards(tab_id, version, document) VALUES (${tabId}, 0, '{}') ON CONFLICT(tab_id) DO NOTHING`;
    return true;
  });
}

function readTarget(sql: Sql, tabId: string, target: CanvasTarget) {
  return Effect.gen(function* () {
    if ("board" in target) {
      const [row] = yield* sql<{
        version: number;
        document: string;
      }>`SELECT version, document FROM canvas_boards WHERE tab_id = ${tabId}`;
      return row && ({ content: JSON.parse(row.document), version: row.version } as Target);
    }
    const [row] = yield* sql<{
      version: number;
      content: string;
      type: string;
    }>`SELECT version, content, type FROM canvas_cards WHERE tab_id = ${tabId} AND card_id = ${target.card} AND deleted_at IS NULL`;
    return (
      row && ({ content: JSON.parse(row.content), version: row.version, type: row.type } as Target)
    );
  });
}

function validateBoard(before: CardContent, after: CardContent) {
  const records = Object.entries(after);
  if (records.length > MAX_BOARD_CARDS)
    throw new ChangeError(`A canvas holds at most ${MAX_BOARD_CARDS} cards.`);
  for (const [id, record] of records) {
    const card = decode(BoardCard, record);
    if (!before[id] && !findCardType(card.type))
      throw new ChangeError(`Scope has no ${card.type} card type.`);
    if (before[id] && before[id].type !== card.type)
      throw new ChangeError("A card keeps its type.");
  }
}

function validateCard(after: CardContent, type: string) {
  const contract = findCardType(type);
  if (!contract) throw new ChangeError("This card needs a newer Scope to change it.");
  const records = Object.values(after);
  if (records.length > contract.limits.records)
    throw new ChangeError(`A card holds at most ${contract.limits.records} records.`);
  if (Buffer.byteLength(JSON.stringify(after)) > MAX_CARD_BYTES)
    throw new ChangeError("A card holds at most 2 MiB.");
  for (const record of records) contract.validate(record);
  const problems = contract.check(after);
  if (problems.length) throw new ChangeError(problems.join(" "));
}

function validate(target: CanvasTarget, before: CardContent, after: CardContent, type?: string) {
  if ("board" in target) validateBoard(before, after);
  else validateCard(after, type ?? "");
}

/**
 * New IDs must come from main: a `$` name in this change, or an ID main reserved for the tab.
 * The first record that uses an ID claims it for its scope, so one ID never names two records;
 * a later put in the same scope, such as an undone delete, brings back that same record.
 */
function claimNewIds(
  sql: Sql,
  tabId: string,
  scope: string,
  before: CardContent,
  ops: readonly CanvasOp[],
) {
  return Effect.gen(function* () {
    const fresh = [
      ...new Set(ops.filter((op) => op.op === "put" && !before[op.id]).map((op) => op.id)),
    ];
    if (!fresh.length) return;
    const known = yield* sql<{
      id: string;
      scope: string | null;
    }>`SELECT id, scope FROM canvas_ids WHERE tab_id = ${tabId} AND ${sql.in("id", fresh)}`;
    if (known.length !== fresh.length)
      return yield* Effect.fail(
        new ChangeError("Create new records with a $ name; Scope picks their IDs."),
      );
    const taken = known.find((row) => row.scope !== null && row.scope !== scope);
    if (taken)
      return yield* Effect.fail(new ChangeError(`${taken.id} already names another record.`));
    yield* sql`UPDATE canvas_ids SET scope = ${scope} WHERE tab_id = ${tabId} AND scope IS NULL AND ${sql.in("id", fresh)}`;
  });
}

function saveTarget(sql: Sql, commit: Commit, before: Target, after: CardContent, now: number) {
  return Effect.gen(function* () {
    const version = before.version + 1;
    const content = JSON.stringify(after);
    if ("board" in commit.target) {
      yield* sql`UPDATE canvas_boards SET version = ${version}, document = ${content} WHERE tab_id = ${commit.tabId}`;
      for (const id of Object.keys(after))
        if (!before.content[id]) {
          const card = decode(BoardCard, after[id]);
          const contract = findCardType(card.type)!;
          yield* sql`INSERT INTO canvas_cards(tab_id, card_id, type, type_version, version, content) VALUES (${commit.tabId}, ${id}, ${card.type}, ${contract.version}, 0, ${JSON.stringify(contract.empty())}) ON CONFLICT(tab_id, card_id) DO UPDATE SET deleted_at = NULL`;
        }
      for (const id of Object.keys(before.content))
        if (!after[id])
          yield* sql`UPDATE canvas_cards SET deleted_at = ${now} WHERE tab_id = ${commit.tabId} AND card_id = ${id}`;
    } else
      yield* sql`UPDATE canvas_cards SET version = ${version}, content = ${content} WHERE tab_id = ${commit.tabId} AND card_id = ${commit.target.card}`;
    return version;
  });
}

/** Keeps the newest steps per scope and removes deleted cards whose delete step is gone. */
function trimHistory(sql: Sql, tabId: string, scope: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      seq: number;
      bytes: number;
    }>`SELECT seq, bytes FROM canvas_history WHERE tab_id = ${tabId} AND scope = ${scope} ORDER BY seq DESC`;
    let total = 0;
    const cut = rows.findIndex((row, index) => {
      total += row.bytes;
      return index >= MAX_HISTORY_ENTRIES || total > MAX_HISTORY_BYTES;
    });
    if (cut < 0) return;
    yield* sql`DELETE FROM canvas_history WHERE tab_id = ${tabId} AND scope = ${scope} AND seq <= ${rows[cut].seq}`;
    if (scope !== "") return;
    const gone = yield* sql<{
      card_id: string;
    }>`DELETE FROM canvas_cards WHERE tab_id = ${tabId} AND deleted_at IS NOT NULL AND deleted_at < coalesce((SELECT min(created_at) FROM canvas_history WHERE tab_id = ${tabId} AND scope = ''), 9223372036854775807) RETURNING card_id`;
    if (gone.length)
      yield* sql`DELETE FROM canvas_history WHERE tab_id = ${tabId} AND ${sql.in(
        "scope",
        gone.map((row) => row.card_id),
      )}`;
  });
}

function receipt(sql: Sql, tabId: string, requestId: string, hash: string) {
  return Effect.map(
    sql<{
      request_hash: string;
      result: string;
    }>`SELECT request_hash, result FROM canvas_requests WHERE tab_id = ${tabId} AND request_id = ${requestId}`,
    ([row]): CanvasWriteResult | undefined =>
      row &&
      (row.request_hash === hash
        ? (JSON.parse(row.result) as CanvasWritten)
        : refused("invalid", "This requestId was already used for a different change.")),
  );
}

function record(sql: Sql, commit: Commit, inverse: CanvasOp[], result: CanvasWritten, now: number) {
  const ops = JSON.stringify(commit.ops);
  const inverseText = JSON.stringify(inverse);
  const bytes = Buffer.byteLength(ops) + Buffer.byteLength(inverseText);
  return Effect.gen(function* () {
    // Receipts outlive trimmed history, so a late retry gets its answer instead of running again.
    yield* sql`INSERT INTO canvas_requests(tab_id, request_id, request_hash, result, created_at) VALUES (${commit.tabId}, ${commit.requestId}, ${commit.hash}, ${JSON.stringify(result)}, ${now})`;
    yield* sql`DELETE FROM canvas_requests WHERE tab_id = ${commit.tabId} AND created_at < ${now - RECEIPT_DAYS * 86_400_000}`;
    yield* sql`INSERT INTO canvas_history(tab_id, scope, seq, request_id, request_hash, actor, kind, undoes, turn_id, label, ops, inverse, result, bytes, created_at)
    VALUES (${commit.tabId}, ${targetScope(commit.target)}, ${result.version}, ${commit.requestId}, ${commit.hash}, ${commit.actor}, ${commit.kind}, ${commit.undoes}, ${commit.turnId}, ${commit.label}, ${ops}, ${inverseText}, ${JSON.stringify(result)}, ${bytes}, ${now})`;
  });
}

/** Finds the fields a stale write would overwrite. Writes that touch other fields replay. */
function staleCheck(
  sql: Sql,
  tabId: string,
  target: CanvasTarget,
  base: number,
  current: Target,
  ops: CanvasOp[],
) {
  return Effect.gen(function* () {
    if (base > current.version)
      return yield* Effect.fail(new ChangeError(`Version ${base} does not exist yet.`));
    if (base === current.version) return { replayedOver: [] as number[] };
    const newer = yield* sql<{
      seq: number;
      ops: string;
    }>`SELECT seq, ops FROM canvas_history WHERE tab_id = ${tabId} AND scope = ${targetScope(target)} AND seq > ${base} ORDER BY seq`;
    if (newer.length !== current.version - base)
      return { stale: `Version ${base} is too old to compare. Read the content again.` };
    const changed = newer.flatMap((row) => touches(JSON.parse(row.ops)));
    const clash = overlap(changed, touches(ops));
    if (!clash) return { replayedOver: newer.map((row) => row.seq) };
    const now = current.content[clash.id];
    const value = clash.field === "*" ? now : now?.[clash.field];
    const shown = value === undefined ? "removed" : JSON.stringify(value).slice(0, 200);
    return {
      conflict: `${clash.id}${clash.field === "*" ? "" : `.${clash.field}`} changed since ${base}; it is now ${shown}.`,
    };
  });
}

export class CanvasStore {
  constructor(private readonly database: Database) {}

  initialize(): Promise<void> {
    return this.database.run(createCanvasTables(this.database.sql));
  }

  async snapshot(tabId: string): Promise<CanvasSnapshot | null> {
    const { sql, run } = this.database;
    return run(
      Effect.gen(function* () {
        if (!(yield* ensureBoard(sql, tabId))) return null;
        const board = (yield* readTarget(sql, tabId, { board: true }))!;
        const cards = yield* sql<{
          card_id: string;
          type: string;
          type_version: number;
          version: number;
          content: string;
        }>`SELECT card_id, type, type_version, version, content FROM canvas_cards WHERE tab_id = ${tabId} AND deleted_at IS NULL`;
        const steps = yield* sql<
          HistoryRow & { scope: string }
        >`SELECT scope, seq, kind, undoes, label FROM canvas_history WHERE tab_id = ${tabId} AND actor = 'person' ORDER BY seq`;
        const history: Record<string, CanvasHistoryState> = {};
        for (const scope of new Set(steps.map((row) => row.scope))) {
          const { undo, redo } = historyStacks(steps.filter((row) => row.scope === scope));
          history[scope] = {
            canUndo: undo.length > 0,
            canRedo: redo.length > 0,
            ...(undo.length ? { undoLabel: undo.at(-1)!.label } : {}),
            ...(redo.length ? { redoLabel: redo.at(-1)!.label } : {}),
          };
        }
        return {
          board: {
            version: board.version,
            cards: board.content as CanvasSnapshot["board"]["cards"],
          },
          cards: Object.fromEntries(
            cards.map((row) => [
              row.card_id,
              {
                type: row.type,
                typeVersion: row.type_version,
                version: row.version,
                content: JSON.parse(row.content),
              },
            ]),
          ),
          history,
        };
      }),
    );
  }

  reserveIds(tabId: string, count: number): Promise<string[]> {
    const { sql, mutate } = this.database;
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* ensureBoard(sql, tabId)))
            return yield* Effect.fail(new ChangeError("This canvas is gone."));
          return yield* newIds(sql, tabId, count);
        }),
      ),
      () => [],
    );
  }

  /**
   * Commits one change. An agent's change passes the `request` it was made from, so a retry
   * with the same request ID is matched against what the agent sent, not the ops worked out
   * from the content at the time. Its `warnings` are saved with the result, so a retry gets
   * them too.
   */
  change(
    change: CanvasChange,
    actor: CanvasActor,
    agent: { turnId: string; request: unknown; warnings: string[] } | null = null,
  ) {
    const turnId = agent?.turnId ?? null;
    const request = agent?.request;
    const hash =
      request === undefined
        ? stableHash({
            target: change.target,
            base: change.base,
            label: change.label,
            ops: change.ops,
          })
        : stableHash({ target: change.target, request });
    return this.write(change.tabId, change.target, change.requestId, hash, (sql, current) =>
      Effect.gen(function* () {
        const checked = yield* staleCheck(sql, change.tabId, change.target, change.base, current, [
          ...change.ops,
        ]);
        if ("stale" in checked) return refused("stale", checked.stale!);
        if ("conflict" in checked) return refused("conflict", checked.conflict!);
        const fresh = change.ops.filter((op) => op.id.startsWith("$")).length;
        const ids = yield* newIds(sql, change.tabId, fresh);
        const { ops, refs } = yield* attempt(() => resolveRefs(change.ops, () => ids.shift()!));
        return {
          commit: {
            tabId: change.tabId,
            target: change.target,
            requestId: change.requestId,
            hash,
            actor,
            kind: "do",
            undoes: null,
            turnId,
            label: change.label,
            ops,
          } satisfies Commit,
          refs,
          replayedOver: checked.replayedOver,
          kept: [],
          ...(agent?.warnings.length ? { warnings: agent.warnings } : {}),
        };
      }),
    );
  }

  /** The saved result of an agent request already answered, if there is one. */
  answered(
    tabId: string,
    target: CanvasTarget,
    requestId: string,
    request: unknown,
  ): Promise<CanvasWriteResult | undefined> {
    const { sql, run } = this.database;
    return run(receipt(sql, tabId, requestId, stableHash({ target, request })));
  }

  /**
   * Undoes every change one agent turn made to a card, as one step of the person's, keeping
   * fields anyone changed after the turn.
   */
  undoTurn(tabId: string, cardId: string, turnId: string, requestId: string) {
    const target = { card: cardId };
    const hash = stableHash({ target, undoTurn: turnId });
    return this.write(tabId, target, requestId, hash, (sql, current) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          ops: string;
          inverse: string;
        }>`SELECT ops, inverse FROM canvas_history WHERE tab_id = ${tabId} AND scope = ${cardId} AND actor = 'agent' AND kind = 'do' AND turn_id = ${turnId} ORDER BY seq`;
        if (!rows.length) return refused("empty", "That turn has nothing left to undo.");
        const guarded = guardedInverse(
          current.content,
          rows.flatMap((row) => JSON.parse(row.ops) as CanvasOp[]),
          combineInverses(rows.map((row) => JSON.parse(row.inverse) as CanvasOp[])),
        );
        if (!guarded.ops.length)
          return refused("empty", "Everything that turn changed was changed again since.");
        return {
          commit: {
            tabId,
            target,
            requestId,
            hash,
            actor: "person",
            kind: "do",
            undoes: null,
            turnId: null,
            label: "Undo turn",
            ops: guarded.ops,
          } satisfies Commit,
          refs: {},
          replayedOver: [],
          kept: guarded.kept,
        };
      }),
    );
  }

  /** Undoes or redoes the actor's latest step in one scope, keeping fields changed since. */
  step(step: CanvasStep, actor: CanvasActor) {
    const hash = stableHash({ target: step.target, direction: step.direction });
    return this.write(step.tabId, step.target, step.requestId, hash, (sql, current) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<HistoryRow>`SELECT seq, kind, undoes, label FROM canvas_history WHERE tab_id = ${step.tabId} AND scope = ${targetScope(step.target)} AND actor = ${actor} ORDER BY seq`;
        const stacks = historyStacks(rows);
        const entry = (step.direction === "undo" ? stacks.undo : stacks.redo).at(-1);
        if (!entry) return refused("empty", `Nothing to ${step.direction}.`);
        const [saved] = yield* sql<{
          ops: string;
          inverse: string;
        }>`SELECT ops, inverse FROM canvas_history WHERE tab_id = ${step.tabId} AND scope = ${targetScope(step.target)} AND seq = ${entry.seq}`;
        const guarded = guardedInverse(
          current.content,
          JSON.parse(saved.ops),
          JSON.parse(saved.inverse),
        );
        return {
          commit: {
            tabId: step.tabId,
            target: step.target,
            requestId: step.requestId,
            hash,
            actor,
            kind: step.direction,
            undoes: entry.seq,
            turnId: null,
            label: entry.label,
            ops: guarded.ops,
          } satisfies Commit,
          refs: {},
          replayedOver: [],
          kept: guarded.kept,
        };
      }),
    );
  }

  private write(
    tabId: string,
    target: CanvasTarget,
    requestId: string,
    hash: string,
    plan: (sql: Sql, current: Target) => Effect.Effect<Planned, unknown>,
  ): Promise<CanvasWriteResult> {
    const { sql, mutate } = this.database;
    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* receipt(sql, tabId, requestId, hash);
        if (saved) return saved;
        if (!(yield* ensureBoard(sql, tabId))) return refused("missing", "This canvas is gone.");
        const current = yield* readTarget(sql, tabId, target);
        if (!current) return refused("missing", "This card is gone.");
        const planned = yield* plan(sql, current);
        if ("ok" in planned) return planned;
        const { commit } = planned;
        yield* claimNewIds(sql, tabId, targetScope(target), current.content, commit.ops);
        const applied = yield* attempt(() => {
          const result = applyOps(current.content, commit.ops);
          validate(target, current.content, result.content, current.type);
          return result;
        });
        const now = Date.now();
        const version = yield* saveTarget(sql, commit, current, applied.content, now);
        const result: CanvasWritten = {
          ok: true,
          version,
          refs: planned.refs,
          replayedOver: planned.replayedOver,
          kept: planned.kept,
          label: commit.label,
          ...(planned.warnings ? { warnings: planned.warnings } : {}),
        };
        yield* record(sql, commit, applied.inverse, result, now);
        yield* trimHistory(sql, tabId, targetScope(target));
        return result;
      }),
    );
    return mutate(
      Effect.catchIf(
        transaction,
        (error): error is ChangeError => error instanceof ChangeError,
        (error) => Effect.succeed(refused("invalid", error.message)),
      ),
      () => [],
    );
  }
}
