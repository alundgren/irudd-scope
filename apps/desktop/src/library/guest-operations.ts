import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Artifact,
  decode,
  MAX_CONTENT_BYTES,
  ScopeError,
  type LiveEvent,
} from "@irudd-scope/protocol";
import { capturePlanBasis, readPlan, validatePlanUpdate } from "@irudd-scope/protocol/plan";
import {
  GuestChange,
  GuestOperation,
  GuestOperationIdentity,
  GuestOutcome,
  GUEST_OPERATION_RETENTION_MS,
  MAX_GUEST_OPERATIONS,
} from "@irudd-scope/protocol/guest-operation";
import { guestSources } from "./guest-source.ts";

type Owner = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  mutate: <A, E>(effect: Effect.Effect<A, E>, event: (result: A) => LiveEvent[]) => Promise<A>;
  changed: () => void;
};
type Row = { caller: string; digest: string; outcome: string; expires_at: number };
const digest = (change: GuestChange) =>
  createHash("sha256")
    .update(
      JSON.stringify(change, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");

/** Only this store executes SQLite-owned guest changes; filesystem operations have their own host journal. */
export class GuestOperations {
  constructor(private readonly owner: Owner) {}
  async initialize() {
    const { sql, run } = this.owner;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          const [{ user_version }] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
          if (user_version < 17) {
            const columns =
              yield* sql`SELECT name FROM pragma_table_info('live_tabs') WHERE name = 'guest_version'`;
            if (!columns.length)
              yield* sql`ALTER TABLE live_tabs ADD COLUMN guest_version INTEGER NOT NULL DEFAULT 1`;
            yield* sql`CREATE TRIGGER IF NOT EXISTS guest_tab_version AFTER UPDATE OF permanent, trashed_at, artifact_id, document ON live_tabs
          WHEN OLD.permanent IS NOT NEW.permanent OR OLD.trashed_at IS NOT NEW.trashed_at OR OLD.artifact_id IS NOT NEW.artifact_id
          OR (json_extract(OLD.document, '$.type') IS NOT json_extract(NEW.document, '$.type'))
          OR (json_extract(OLD.document, '$.state.version') IS NOT json_extract(NEW.document, '$.state.version'))
          OR (NEW.artifact_id IS NULL AND json_extract(OLD.document, '$.title') IS NOT json_extract(NEW.document, '$.title'))
          BEGIN UPDATE live_tabs SET guest_version = guest_version + 1 WHERE id = NEW.id; END`;
            yield* sql`CREATE TRIGGER IF NOT EXISTS guest_artifact_version AFTER UPDATE OF document ON artifacts
          WHEN OLD.document IS NOT NEW.document
          BEGIN UPDATE live_tabs SET guest_version = guest_version + 1 WHERE id = NEW.tab_id; END`;
            yield* sql`PRAGMA user_version = 17`;
          }
          yield* sql`CREATE TABLE IF NOT EXISTS guest_operations (
        id TEXT PRIMARY KEY, caller TEXT NOT NULL, digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(json_valid(outcome))) STRICT`;
          yield* sql`INSERT INTO lifecycle(name, value) VALUES ('guest_clock', 0) ON CONFLICT(name) DO NOTHING`;
        }),
      ),
    );
  }
  private clock() {
    const sql = this.owner.sql;
    return Effect.gen(function* () {
      const [row] = yield* sql<{
        value: number;
      }>`UPDATE lifecycle SET value = max(value, ${Date.now()}) WHERE name = 'guest_clock' RETURNING value`;
      return row.value;
    });
  }
  prepare(caller: string, input: GuestChange, signal: AbortSignal): Promise<GuestOutcome> {
    const change = decode(GuestChange, input);
    const { sql } = this.owner;
    const clock = this.clock();
    return this.owner.run(
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* clock;
          yield* sql`DELETE FROM guest_operations WHERE expires_at <= ${now}`;
          const [{ count }] = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM guest_operations`;
          if (count >= MAX_GUEST_OPERATIONS)
            return yield* Effect.fail(
              new Error("Owner operation capacity reached. Wait for receipts to expire."),
            );
          const [source] = yield* guestSources(sql, change.target.sourceTabId);
          if (!source || source.kind === "folder")
            return yield* Effect.fail(
              new Error("This source does not support artifact mutations."),
            );
          const outcome: GuestOutcome = {
            operationId: randomUUID(),
            digest: digest(change),
            state: "prepared",
            expiresAt: now + GUEST_OPERATION_RETENTION_MS,
          };
          yield* Effect.sync(() => signal.throwIfAborted());
          yield* sql`INSERT INTO guest_operations VALUES (${outcome.operationId}, ${caller}, ${outcome.digest}, ${outcome.expiresAt}, ${JSON.stringify(outcome)})`;
          yield* Effect.sync(() => signal.throwIfAborted());
          return outcome;
        }),
      ),
    );
  }
  /** Status settles a prepared ID as rejected. A delayed execute cannot run after this commits. */
  status(
    caller: string,
    input: GuestOperationIdentity,
    signal: AbortSignal,
  ): Promise<GuestOutcome> {
    const identity = decode(GuestOperationIdentity, input);
    const { sql } = this.owner;
    const clock = this.clock();
    return this.owner.run(
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* clock;
          const [row] =
            yield* sql<Row>`SELECT * FROM guest_operations WHERE id = ${identity.operationId}`;
          const outcome = resolve(row, caller, identity, now);
          if (outcome.state === "prepared") {
            const settled: GuestOutcome = {
              ...outcome,
              state: "rejected",
              message:
                "No source change committed. Status lookup cancelled this prepared operation.",
            };
            yield* sql`UPDATE guest_operations SET outcome = ${JSON.stringify(settled)} WHERE id = ${identity.operationId}`;
            yield* Effect.sync(() => signal.throwIfAborted());
            return settled;
          }
          yield* Effect.sync(() => signal.throwIfAborted());
          return outcome;
        }),
      ),
    );
  }
  async execute(caller: string, input: GuestOperation, signal: AbortSignal): Promise<GuestOutcome> {
    const operation = decode(GuestOperation, input);
    if (digest(operation.change) !== operation.digest)
      throw new Error("Operation body does not match its prepared identity.");
    const { sql } = this.owner;
    const clock = this.clock();
    const committed = await this.owner.mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* clock;
          const [row] =
            yield* sql<Row>`SELECT * FROM guest_operations WHERE id = ${operation.operationId}`;
          const saved = resolve(row, caller, operation, now);
          if (saved.state !== "prepared")
            return { outcome: saved, artifact: undefined as Artifact | undefined };
          const change = operation.change;
          const [source] = yield* guestSources(sql, change.target.sourceTabId);
          let result: GuestOutcome;
          let notification: Artifact | undefined;
          if (!source || source.kind === "folder")
            result = { ...saved, state: "rejected", message: "This source is no longer shared." };
          else if (
            source.sourceVersion !== change.expectedSourceVersion ||
            (source.artifact?.revision ?? 0) !== change.expectedRevision
          )
            result = {
              ...saved,
              state: "conflict",
              sourceVersion: source.sourceVersion,
              artifact: source.artifact,
              message:
                "The owner changed this source. Your input is retained; review the current owner revision.",
            };
          else {
            yield* Effect.sync(() => signal.throwIfAborted());
            const changed = yield* apply(sql, change).pipe(
              Effect.catchIf(
                (error) => error instanceof ScopeError,
                (error) => Effect.succeed(error),
              ),
            );
            if (changed instanceof ScopeError)
              result = {
                ...saved,
                state: "rejected",
                message: changed.message.slice(0, 1024),
                sourceVersion: source.sourceVersion,
                artifact: source.artifact,
              };
            else {
              notification = changed;
              const [current] = yield* guestSources(sql, change.target.sourceTabId);
              result = {
                ...saved,
                state: "completed",
                sourceVersion: current?.sourceVersion,
                artifact: current?.artifact,
              };
            }
          }
          yield* sql`UPDATE guest_operations SET outcome = ${JSON.stringify(result)} WHERE id = ${operation.operationId}`;
          yield* Effect.sync(() => signal.throwIfAborted());
          return { outcome: result, artifact: notification };
        }),
      ),
      (result) => (result.artifact ? [{ type: "artifact", artifact: result.artifact }] : []),
    );
    if (committed.outcome.state === "completed") this.owner.changed();
    return committed.outcome;
  }
}
function resolve(
  row: Row | undefined,
  caller: string,
  input: GuestOperationIdentity,
  now: number,
): GuestOutcome {
  const identity = { operationId: input.operationId, digest: input.digest };
  if (!row)
    return {
      ...identity,
      state: "unknown",
      expiresAt: 0,
      message: "No retained outcome. Do not replay this operation; reconcile the current source.",
    };
  if (row.caller !== caller || row.digest !== identity.digest)
    throw new Error("Operation belongs to a different caller or body.");
  if (row.expires_at <= now)
    return {
      ...identity,
      state: "expired",
      expiresAt: row.expires_at,
      message: "Outcome expired. Do not replay; reconcile the current source.",
    };
  return decode(GuestOutcome, JSON.parse(row.outcome));
}
function apply(sql: SqliteClient.SqliteClient, change: GuestChange) {
  return Effect.gen(function* () {
    const id = change.target.sourceTabId;
    const action = change.action;
    if (action.kind === "trash") {
      yield* sql`UPDATE live_tabs SET trashed_at = ${Date.now()} WHERE id = ${id}`;
      return;
    }
    if (action.kind === "retention") {
      yield* sql`UPDATE live_tabs SET permanent = ${Number(action.permanent)}, last_visible_at = ${Date.now()} WHERE id = ${id}`;
      return;
    }
    const [row] = yield* sql<{
      document: string;
    }>`SELECT document FROM artifacts WHERE tab_id = ${id}`;
    if (!row)
      return yield* Effect.fail(new ScopeError(400, "This source has no supported artifact."));
    const previous = decode(Artifact, JSON.parse(row.document));
    const artifact = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (action.kind === "rename") artifact.title = action.title;
    if (previous.kind === "plan") {
      const [old] = yield* sql<{
        content: Uint8Array;
      }>`SELECT content FROM blobs WHERE id = ${previous.blob}`;
      const bytes = yield* Effect.try({
        try: () => {
          const prior = readPlan(old.content);
          const plan =
            action.kind === "rename"
              ? { ...prior, title: action.title }
              : action.kind === "capture-basis"
                ? capturePlanBasis(prior, previous.revision, action.basisId)
                : action.document;
          const bytes = Buffer.from(JSON.stringify(plan));
          const validated = readPlan(bytes);
          validatePlanUpdate(validated, prior, previous.revision);
          artifact.title = validated.title;
          return bytes;
        },
        catch: (error) => error as ScopeError,
      });
      if (bytes.length > MAX_CONTENT_BYTES)
        return yield* Effect.fail(new ScopeError(413, "Plan exceeds the 32 MiB limit."));
      artifact.blob = createHash("sha256").update(bytes).digest("hex");
      artifact.size = bytes.length;
      yield* sql`INSERT INTO blobs(id, content) VALUES (${artifact.blob}, ${bytes}) ON CONFLICT(id) DO NOTHING`;
      yield* sql`INSERT INTO tab_blobs VALUES (${id}, ${artifact.blob}, 0) ON CONFLICT(tab_id, blob_id) DO NOTHING`;
    } else if (action.kind !== "rename")
      return yield* Effect.fail(new ScopeError(400, "Only plans support this action."));
    yield* sql`UPDATE artifacts SET revision = ${artifact.revision}, document = ${JSON.stringify(artifact)}, blob_id = ${artifact.blob} WHERE tab_id = ${id}`;
    yield* sql`UPDATE lifecycle SET value = max(value, ${artifact.revision}) WHERE name = 'max_revision'`;
    yield* sql`UPDATE live_tabs SET document = json_set(document, '$.title', ${artifact.title}) WHERE id = ${id} AND document IS NOT NULL`;
    return artifact;
  });
}
