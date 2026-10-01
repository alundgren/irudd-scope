import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, ScopeError, decode } from "@irudd-scope/protocol";
import {
  PlanSnapshot,
  MAX_PLAN_REPLY_BYTES,
  PLAN_READ_CONFLICT,
  type PlanCommand,
  type PlanReply,
} from "@irudd-scope/protocol/plan";

type ReadCommand = Extract<PlanCommand, { action: "read" }>;
export type PlanOwner = {
  tab_id: string;
  document: string;
  trashed_at: number | null;
  version: number;
};
const PAGE_SIZE = 100;
const PAGE_BYTES = MAX_PLAN_REPLY_BYTES - 512 * 1024;

export function readPlanPage(
  sql: SqliteClient.SqliteClient,
  owner: PlanOwner,
  command: ReadCommand,
) {
  return Effect.gen(function* () {
    if (command.pending && command.roundId)
      return yield* Effect.fail(new ScopeError(400, "Choose either pending rounds or one round."));
    if (command.cursor && command.cursor.version !== owner.version)
      return yield* Effect.fail(new ScopeError(409, PLAN_READ_CONFLICT));
    if (!command.cursor && command.since === owner.version)
      return { type: "unchanged", version: owner.version } as PlanReply;
    const artifact = decode(Artifact, JSON.parse(owner.document));
    const afterRevision = command.cursor?.afterRevision ?? 0;
    const afterRecord = command.cursor?.afterRecord ?? 0;
    let origin = artifact.revision;
    if (command.roundId) {
      const [round] = yield* sql<{
        revision: number;
      }>`SELECT json_extract(document, '$.revision') AS revision FROM plan_records WHERE tab_id = ${owner.tab_id} AND kind = 'round' AND id = ${command.roundId}`;
      if (!round) return yield* Effect.fail(new ScopeError(404, "Plan round not found."));
      origin = round.revision;
    }
    const revisionFilter = command.roundId
      ? sql`revision IN (${origin}, ${artifact.revision})`
      : command.pending
        ? sql`revision = ${artifact.revision}`
        : sql`1 = 1`;
    const recordFilter = command.roundId
      ? sql`((kind = 'round' AND id = ${command.roundId}) OR (kind = 'response' AND json_extract(document, '$.roundId') = ${command.roundId}) OR (kind = 'comment' AND id IN (SELECT value FROM json_each((SELECT document FROM plan_records WHERE tab_id = ${owner.tab_id} AND id = ${command.roundId} AND kind = 'round'), '$.commentIds'))))`
      : command.pending
        ? sql`kind = 'round' AND json_extract(document, '$.status') = 'pending'`
        : sql`1 = 1`;
    const revisionRows = yield* sql<{
      revision: number;
      bytes: number;
    }>`SELECT revision, length(CAST(json_object('revision', revision, 'title', title, 'createdAt', created_at, 'approvedAt', approved_at) AS BLOB)) AS bytes FROM plan_revisions WHERE tab_id = ${owner.tab_id} AND revision > ${afterRevision} AND ${revisionFilter} ORDER BY revision LIMIT ${PAGE_SIZE + 1}`;
    const recordRows = yield* sql<{
      rowid: number;
      bytes: number;
    }>`SELECT rowid, length(CAST(document AS BLOB)) AS bytes FROM plan_records WHERE tab_id = ${owner.tab_id} AND rowid > ${afterRecord} AND ${recordFilter} ORDER BY rowid LIMIT ${PAGE_SIZE + 1}`;
    let bytes = 0;
    const revisions: number[] = [];
    const records: number[] = [];
    for (const row of revisionRows) {
      if (revisions.length === PAGE_SIZE || bytes + row.bytes + 1 > PAGE_BYTES) break;
      revisions.push(row.revision);
      bytes += row.bytes + 1;
    }
    for (const row of recordRows) {
      if (records.length === PAGE_SIZE || bytes + row.bytes + 1 > PAGE_BYTES) break;
      records.push(row.rowid);
      bytes += row.bytes + 1;
    }
    if (!revisions.length && !records.length && (revisionRows.length || recordRows.length))
      return yield* Effect.fail(
        new ScopeError(413, "A retained plan record exceeds the reply limit."),
      );
    const selectedRevisions = revisions.length
      ? yield* sql<{
          revision: number;
          title: string;
          createdAt: string;
          approvedAt: string | null;
        }>`SELECT revision, title, created_at AS createdAt, approved_at AS approvedAt FROM plan_revisions WHERE tab_id = ${owner.tab_id} AND ${sql.in("revision", revisions)} ORDER BY revision`
      : [];
    const selectedRecords = records.length
      ? yield* sql<{
          kind: string;
          document: string;
        }>`SELECT kind, document FROM plan_records WHERE tab_id = ${owner.tab_id} AND ${sql.in("rowid", records)} ORDER BY rowid`
      : [];
    const snapshot = decode(PlanSnapshot, {
      artifact,
      version: owner.version,
      revisions: selectedRevisions,
      comments: selectedRecords
        .filter((row) => row.kind === "comment")
        .map((row) => JSON.parse(row.document)),
      rounds: selectedRecords
        .filter((row) => row.kind === "round")
        .map((row) => JSON.parse(row.document)),
      responses: selectedRecords
        .filter((row) => row.kind === "response")
        .map((row) => JSON.parse(row.document)),
    });
    const more = revisions.length < revisionRows.length || records.length < recordRows.length;
    return {
      type: "snapshot",
      snapshot,
      ...(more
        ? {
            next: {
              version: owner.version,
              afterRevision: revisions.at(-1) ?? afterRevision,
              afterRecord: records.at(-1) ?? afterRecord,
            },
          }
        : {}),
    } as PlanReply;
  });
}
