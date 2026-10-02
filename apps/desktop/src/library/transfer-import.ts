import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, ScopeError, decode } from "@irudd-scope/protocol";
import { decodeTransferManifest, type TransferManifest } from "@irudd-scope/protocol/transfer";
import { Tab } from "../workspace/contract.ts";

export type TransferReceipt = {
  artifact: Artifact;
  tab: Tab;
  alreadyImported: boolean;
  originalBlob: string;
};

export function transferReceipt(sql: SqliteClient.SqliteClient, sourceId: string, id: string) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{
      imported_artifact: string;
      current_artifact: string | null;
      current_tab: string | null;
      current_id: string | null;
      trashed_at: number | null;
    }>`SELECT transfer_receipts.artifact AS imported_artifact, artifacts.document AS current_artifact, live_tabs.document AS current_tab, live_tabs.id AS current_id, live_tabs.trashed_at FROM transfer_receipts LEFT JOIN live_tabs ON live_tabs.id = json_extract(transfer_receipts.tab, '$.id') LEFT JOIN artifacts ON artifacts.id = json_extract(transfer_receipts.artifact, '$.id') WHERE source_id = ${sourceId} AND invitation_id = ${id}`;
    if (!row) return null;
    if (!row.current_id || !row.current_artifact || !row.current_tab || row.trashed_at !== null)
      return yield* Effect.fail(
        new ScopeError(
          409,
          "This transfer was already imported. Its tab has since been removed or moved to Trashcan.",
        ),
      );
    return {
      artifact: decode(Artifact, JSON.parse(row.current_artifact)),
      tab: decode(Tab, JSON.parse(row.current_tab)),
      alreadyImported: true,
      originalBlob: decode(Artifact, JSON.parse(row.imported_artifact)).blob,
    };
  });
}

export function validateTransferredContent(manifest: TransferManifest, bytes: Uint8Array): void {
  if (
    bytes.byteLength !== manifest.size ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.blob
  )
    throw new ScopeError(
      400,
      "The transferred content is incomplete or does not match its checksum.",
    );
  if (manifest.kind === "excalidraw") {
    const document = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !document ||
      document.type !== "excalidraw" ||
      !Array.isArray(document.elements) ||
      document.elements.length > 10_000
    )
      throw new ScopeError(400, "The transferred diagram is invalid.");
  }
}

export function importTransferredTab(
  sql: SqliteClient.SqliteClient,
  sourceId: string,
  id: string,
  expiresAt: number,
  groupId: string,
  value: TransferManifest,
  bytes: Uint8Array,
  now: () => number,
) {
  const manifest = decodeTransferManifest(value);
  validateTransferredContent(manifest, bytes);
  return sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* transferReceipt(sql, sourceId, id);
      if (existing) {
        if (existing.originalBlob !== manifest.blob)
          return yield* Effect.fail(
            new ScopeError(409, "This transfer already imported different content."),
          );
        return existing;
      }
      const timestamp = now();
      if (timestamp >= expiresAt)
        return yield* Effect.fail(new ScopeError(410, "This transfer invitation has expired."));
      const tabId = randomUUID();
      const artifactId = `transfer-${randomUUID()}`;
      const [{ value: revision }] = yield* sql<{
        value: number;
      }>`SELECT value FROM lifecycle WHERE name = 'revision_floor'`;
      const { version: _version, ...metadata } = manifest;
      const artifact = decode(Artifact, {
        ...metadata,
        id: artifactId,
        revision,
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
      });
      const tab = decode(Tab, {
        id: tabId,
        groupId,
        type: manifest.kind === "excalidraw" ? "diagram" : "file",
        title: manifest.title,
        state: { version: 1, data: { artifactId } },
      });
      yield* sql`INSERT INTO live_tabs(id, artifact_id, opened, created_at, document, position, last_visible_at) VALUES (${tabId}, ${artifactId}, 1, ${timestamp}, ${JSON.stringify(tab)}, (SELECT coalesce(max(position), -1) + 1 FROM live_tabs WHERE opened = 1), ${timestamp})`;
      yield* sql`INSERT INTO blobs(id, content) VALUES (${manifest.blob}, ${bytes}) ON CONFLICT(id) DO NOTHING`;
      yield* sql`INSERT INTO tab_blobs VALUES (${tabId}, ${manifest.blob}, 0)`;
      yield* sql`INSERT INTO artifacts(id, revision, document, tab_id, blob_id) VALUES (${artifactId}, ${revision}, ${JSON.stringify(artifact)}, ${tabId}, ${manifest.blob})`;
      yield* sql`UPDATE lifecycle SET value = max(value, ${revision}) WHERE name = 'max_revision'`;
      yield* sql`INSERT INTO transfer_receipts(source_id, invitation_id, expires_at, artifact, tab) VALUES (${sourceId}, ${id}, ${expiresAt}, ${JSON.stringify(artifact)}, ${JSON.stringify(tab)})`;
      return { artifact, tab, alreadyImported: false, originalBlob: manifest.blob };
    }),
  );
}
