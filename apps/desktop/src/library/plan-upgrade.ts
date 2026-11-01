import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, decode } from "@irudd-scope/protocol";
import { checkFingerprint, decodePlan, type PlanCheck } from "@irudd-scope/protocol/plan";

type V1Check = PlanCheck;
type V1Evidence = {
  id: string;
  basisId: string;
  checkId: string;
  observed: string;
  implementation: string;
  conditions: string;
  result: "passed" | "failed" | "blocked";
  references?: string[];
};
type V1Plan = {
  version: 1;
  checks?: V1Check[];
  bases?: { id: string; proposal: { checks?: V1Check[] } }[];
  agreements?: unknown;
  evidence?: V1Evidence[];
  removedRecordIds?: unknown;
  [key: string]: unknown;
};

/**
 * Format version 1 kept full copies of earlier proposals so records stayed meaningful. Version 2
 * keeps evidence only where the check it was recorded against still reads the same.
 */
export function convertPlanV1(plan: V1Plan) {
  const {
    bases = [],
    agreements: _agreements,
    evidence = [],
    removedRecordIds: _removed,
    ...proposal
  } = plan;
  const current = new Map((proposal.checks ?? []).map((check) => [check.id, check]));
  const kept = evidence.flatMap((record) => {
    const check = current.get(record.checkId);
    const recorded = bases
      .find((basis) => basis.id === record.basisId)
      ?.proposal.checks?.find((x) => x.id === record.checkId);
    if (!check || !recorded || checkFingerprint(recorded) !== checkFingerprint(check)) return [];
    return [
      {
        id: record.id,
        checkId: record.checkId,
        checkFingerprint: checkFingerprint(check),
        result: record.result,
        observed: record.observed,
        implementation: record.implementation,
        conditions: record.conditions,
        ...(record.references ? { references: record.references } : {}),
      },
    ];
  });
  return decodePlan({ ...proposal, version: 2, ...(kept.length ? { evidence: kept } : {}) });
}

export function upgradePlanDocuments(sql: SqliteClient.SqliteClient) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const [{ user_version }] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
      if (user_version >= 18) return;
      const rows = yield* sql<{
        tab_id: string;
        document: string;
        content: Uint8Array;
      }>`SELECT artifacts.tab_id, artifacts.document, blobs.content FROM artifacts JOIN blobs ON blobs.id = artifacts.blob_id WHERE json_extract(artifacts.document, '$.kind') = 'plan' AND json_extract(artifacts.document, '$.mediaType') = 'application/json'`;
      for (const row of rows) {
        const old = JSON.parse(Buffer.from(row.content).toString("utf8")) as V1Plan;
        if (old.version !== 1) continue;
        const bytes = Buffer.from(JSON.stringify(convertPlanV1(old)));
        const previous = decode(Artifact, JSON.parse(row.document));
        const artifact = {
          ...previous,
          blob: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        yield* sql`INSERT INTO blobs(id, content) VALUES (${artifact.blob}, ${bytes}) ON CONFLICT(id) DO NOTHING`;
        yield* sql`INSERT INTO tab_blobs VALUES (${row.tab_id}, ${artifact.blob}, 0) ON CONFLICT(tab_id, blob_id) DO NOTHING`;
        yield* sql`UPDATE artifacts SET revision = ${artifact.revision}, document = ${JSON.stringify(artifact)}, blob_id = ${artifact.blob} WHERE tab_id = ${row.tab_id}`;
        yield* sql`UPDATE lifecycle SET value = max(value, ${artifact.revision}) WHERE name = 'max_revision'`;
      }
      yield* sql`PRAGMA user_version = 18`;
    }),
  );
}
