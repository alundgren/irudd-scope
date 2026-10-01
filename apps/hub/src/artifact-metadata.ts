import type { DatabaseSync } from "node:sqlite";
import { Artifact, BUFFERED_TAB_TTL_MS, ScopeError, decode } from "@irudd-scope/protocol";

const MAX_SAVED_ARTIFACTS = 1000;

export function artifactMetadataRequest(method: string, path: string) {
  return (
    (["GET", "PUT", "DELETE"].includes(method) && /^\/v1\/artifacts\/[^/?]+$/.test(path)) ||
    (method === "GET" && /^\/v1\/names\/[^/?]+$/.test(path))
  );
}

export class ArtifactMetadata {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number,
  ) {}

  expire() {
    this.database
      .prepare("DELETE FROM artifact_metadata WHERE observed_at <= ?")
      .run(this.now() - BUFFERED_TAB_TTL_MS);
  }

  remember(value: unknown) {
    const artifact = decode(Artifact, value);
    this.expire();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`INSERT INTO artifact_metadata(id, name, revision, document, observed_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, revision = excluded.revision, document = excluded.document,
      observed_at = excluded.observed_at WHERE excluded.revision >= artifact_metadata.revision`)
        .run(
          artifact.id,
          artifact.name ?? null,
          artifact.revision,
          JSON.stringify(artifact),
          this.now(),
        );
      this.database
        .prepare(`DELETE FROM artifact_metadata WHERE id IN
      (SELECT id FROM artifact_metadata ORDER BY observed_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
        .run(MAX_SAVED_ARTIFACTS);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  observe(method: string, path: string, status: number, value: unknown) {
    if (!artifactMetadataRequest(method, path)) return;
    if ((method === "DELETE" && status < 400) || status === 404) {
      if (path.startsWith("/v1/artifacts/")) this.remove(path.slice("/v1/artifacts/".length));
    } else if (status < 400) this.remember(value);
  }

  read(key: string, byName: boolean): Artifact {
    this.expire();
    const row = this.database
      .prepare(`SELECT document FROM artifact_metadata WHERE ${byName ? "name" : "id"} = ?
      ORDER BY observed_at DESC, rowid DESC LIMIT 1`)
      .get(key);
    if (!row)
      throw new ScopeError(
        503,
        "The hub has no saved revision for this tab. Read or publish it through this hub while Scope is connected before updating offline.",
      );
    return decode(Artifact, JSON.parse(row.document as string));
  }

  remove(id: string) {
    this.database.prepare("DELETE FROM artifact_metadata WHERE id = ?").run(id);
  }

  clear() {
    this.database.exec("DELETE FROM artifact_metadata");
  }
}
