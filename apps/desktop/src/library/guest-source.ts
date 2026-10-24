import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, decode } from "@irudd-scope/protocol";
import { GUEST_CATALOG_LIMIT, type GuestSource } from "@irudd-scope/protocol/guest";
import { guestSourceKind } from "../plugins/registry.ts";
import { Tab } from "../workspace/contract.ts";

export function guestSources(sql: SqliteClient.SqliteClient, id?: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      document: string | null;
      artifact: string | null;
      folder: string | null;
      guest_version: number;
      permanent: number;
    }>`SELECT t.id, t.document, t.guest_version, t.permanent, a.document AS artifact, f.tab_id AS folder
      FROM live_tabs t
      LEFT JOIN artifacts a ON a.tab_id = t.id AND a.id = t.artifact_id
      LEFT JOIN tab_blobs r ON r.tab_id = t.id AND r.blob_id = a.blob_id
      LEFT JOIN blobs b ON b.id = r.blob_id
      LEFT JOIN folder_tabs f ON f.tab_id = t.id
      WHERE t.trashed_at IS NULL AND (${id ?? null} IS NULL OR t.id = ${id ?? null})
      AND ((a.id IS NOT NULL AND b.id IS NOT NULL) OR (t.opened = 1 AND f.tab_id IS NOT NULL)) ORDER BY t.id`;
    const sources: GuestSource[] = [];
    for (const row of rows) {
      const tab = row.document ? decode(Tab, JSON.parse(row.document)) : undefined;
      const artifact = row.artifact ? decode(Artifact, JSON.parse(row.artifact)) : undefined;
      const kind = guestSourceKind(tab, artifact);
      if (!kind || (kind === "folder" && !row.folder)) continue;
      const { source: _source, ...metadata } = artifact ?? {};
      sources.push({
        sourceTabId: row.id,
        title: artifact?.title ?? tab!.title,
        kind,
        version: 1,
        sourceVersion: row.guest_version,
        permanent: Boolean(row.permanent),
        ...(artifact ? { artifact: metadata as Artifact } : {}),
      });
    }
    if (sources.length > GUEST_CATALOG_LIMIT)
      return yield* Effect.fail(
        new Error("Too many shared tabs. The catalog could not be refreshed."),
      );
    return sources;
  });
}
