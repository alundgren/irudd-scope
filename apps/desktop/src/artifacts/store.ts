import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Artifact,
  ArtifactWrite,
  BlobId,
  MAX_CONTENT_BYTES,
  ScopeError,
  decode,
  validateArtifactContent,
} from "@irudd-scope/protocol";

export class ArtifactStore {
  private readonly db: DatabaseSync;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const database = join(directory, "scope.db");
    this.db = new DatabaseSync(database);
    chmodSync(database, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 1) {
      this.db.close();
      throw new Error("The artifact database requires a newer Scope version.");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        document TEXT NOT NULL CHECK (json_valid(document))
      ) STRICT;
      PRAGMA user_version = 1;
    `);
  }

  blobPath(blob: string): string {
    return join(this.directory, "blobs", decode(BlobId, blob).slice(0, 2), blob);
  }

  async upload(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    const temporaryDirectory = join(this.directory, "tmp");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(temporaryDirectory, randomUUID());
    const file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > MAX_CONTENT_BYTES)
          throw new ScopeError(413, "Artifact exceeds the 32 MiB limit.");
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      await file.sync();
      await file.close();
      const blob = hash.digest("hex");
      await mkdir(join(this.directory, "blobs", blob.slice(0, 2)), {
        recursive: true,
        mode: 0o700,
      });
      await rename(temporary, this.blobPath(blob));
      return blob;
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  get(id: string): Artifact {
    const row = this.db.prepare("SELECT document FROM artifacts WHERE id = ?").get(id) as
      | { document: string }
      | undefined;
    if (!row) throw new ScopeError(404, "Artifact not found.");
    return decode(Artifact, JSON.parse(row.document));
  }

  list(after = ""): { items: Artifact[]; next: string | null } {
    const rows = this.db
      .prepare("SELECT document FROM artifacts WHERE id > ? ORDER BY id LIMIT 101")
      .all(after) as { document: string }[];
    const items = rows.slice(0, 100).map((row) => decode(Artifact, JSON.parse(row.document)));
    return { items, next: rows.length > 100 ? items.at(-1)!.id : null };
  }

  async put(id: string, input: ArtifactWrite): Promise<Artifact> {
    validateArtifactContent(input);
    const info = await stat(this.blobPath(input.blob)).catch(() => {
      throw new ScopeError(400, "Upload the artifact content first.");
    });
    if (info.size > MAX_CONTENT_BYTES)
      throw new ScopeError(413, "Artifact exceeds the content limit.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT document FROM artifacts WHERE id = ?").get(id) as
        | { document: string }
        | undefined;
      const previous = current ? decode(Artifact, JSON.parse(current.document)) : undefined;
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw new ScopeError(409, "Artifact changed. Read the current revision before updating.");
      const { expectedRevision, ...metadata } = input;
      const now = new Date().toISOString();
      const artifact = decode(Artifact, {
        ...metadata,
        id,
        revision: expectedRevision + 1,
        size: info.size,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      this.db
        .prepare(
          "INSERT INTO artifacts(id, revision, document) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document",
        )
        .run(id, artifact.revision, JSON.stringify(artifact));
      this.db.exec("COMMIT");
      return artifact;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
