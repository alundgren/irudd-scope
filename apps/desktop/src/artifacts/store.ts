import { createHash } from "node:crypto";
import { mkdir, chmod, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Artifact,
  ArtifactWrite,
  BlobId,
  MAX_CONTENT_BYTES,
  ScopeError,
  decode,
  validateArtifactContent,
} from "@irudd-scope/protocol";

const databaseRuntime = (filename: string) => ManagedRuntime.make(SqliteClient.layer({ filename }));

export class ArtifactStore {
  private constructor(
    private readonly runtime: ReturnType<typeof databaseRuntime>,
    private readonly sql: SqliteClient.SqliteClient,
  ) {}

  static async open(directory: string): Promise<ArtifactStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "scope.db");
    const runtime = databaseRuntime(filename);
    try {
      const sql = await runtime.runPromise(SqliteClient.SqliteClient);
      await chmod(filename, 0o600);
      const store = new ArtifactStore(runtime, sql);
      await store.initialize(directory);
      return store;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  private async initialize(directory: string): Promise<void> {
    const sql = this.sql;
    const [{ user_version: version }] = await this.runtime.runPromise(
      sql<{ user_version: number }>`PRAGMA user_version`,
    );
    if (version > 2) throw new Error("The artifact database requires a newer Scope version.");
    if (version === 2) return;

    const legacyDirectory = join(directory, "blobs");
    const paths: { id: string; path: string }[] = [];
    const directories = await readdir(legacyDirectory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const prefix of directories) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name))
        throw new Error("Unexpected file in the legacy artifact store. Migration stopped.");
      for (const entry of await readdir(join(legacyDirectory, prefix.name), {
        withFileTypes: true,
      })) {
        if (
          !entry.isFile() ||
          !/^[a-f0-9]{64}$/.test(entry.name) ||
          !entry.name.startsWith(prefix.name)
        )
          throw new Error("Unexpected file in the legacy artifact store. Migration stopped.");
        paths.push({ id: entry.name, path: join(legacyDirectory, prefix.name, entry.name) });
      }
    }

    await this.runtime.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        document TEXT NOT NULL CHECK (json_valid(document))
      ) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS blobs (
        id TEXT PRIMARY KEY,
        content BLOB NOT NULL CHECK (length(content) <= 33554432)
      ) STRICT`;
          for (const entry of paths) {
            const bytes = yield* Effect.promise(() => readFile(entry.path));
            if (
              bytes.length > MAX_CONTENT_BYTES ||
              createHash("sha256").update(bytes).digest("hex") !== entry.id
            )
              return yield* Effect.fail(
                new Error("Legacy artifact content failed verification. Migration stopped."),
              );
            yield* sql`INSERT INTO blobs(id, content) VALUES (${entry.id}, ${bytes}) ON CONFLICT(id) DO NOTHING`;
          }
          const records = yield* sql<{ document: string }>`SELECT document FROM artifacts`;
          for (const record of records) {
            const artifact = decode(Artifact, JSON.parse(record.document));
            const [blob] = yield* sql<{
              size: number;
            }>`SELECT length(content) AS size FROM blobs WHERE id = ${artifact.blob}`;
            if (!blob || blob.size !== artifact.size)
              return yield* Effect.fail(
                new Error("Legacy artifact content is missing or incomplete. Migration stopped."),
              );
          }
          yield* sql`PRAGMA user_version = 2`;
        }),
      ),
    );

    // Only verified content is removed, after the database transaction commits.
    await rm(legacyDirectory, { recursive: true, force: true });
    await rm(join(directory, "tmp"), { recursive: true, force: true });
  }

  async upload(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    const parts: Buffer[] = [];
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > MAX_CONTENT_BYTES) throw new ScopeError(413, "Artifact exceeds the 32 MiB limit.");
      hash.update(chunk);
      parts.push(Buffer.from(chunk));
    }
    const id = hash.digest("hex");
    const bytes = Buffer.concat(parts, size);
    await this.runtime.runPromise(
      this.sql`INSERT INTO blobs(id, content) VALUES (${id}, ${bytes}) ON CONFLICT(id) DO NOTHING`,
    );
    return id;
  }

  async content(id: string): Promise<Buffer> {
    decode(BlobId, id);
    const [row] = await this.runtime.runPromise(
      this.sql<{ content: Uint8Array }>`SELECT content FROM blobs WHERE id = ${id}`,
    );
    if (!row) throw new ScopeError(404, "Artifact content not found.");
    return Buffer.from(row.content);
  }

  async get(id: string): Promise<Artifact> {
    const [row] = await this.runtime.runPromise(
      this.sql<{ document: string }>`SELECT document FROM artifacts WHERE id = ${id}`,
    );
    if (!row) throw new ScopeError(404, "Artifact not found.");
    return decode(Artifact, JSON.parse(row.document));
  }

  async list(after = ""): Promise<{ items: Artifact[]; next: string | null }> {
    const rows = await this.runtime.runPromise(
      this.sql<{
        document: string;
      }>`SELECT document FROM artifacts WHERE id > ${after} ORDER BY id LIMIT 101`,
    );
    const items = rows.slice(0, 100).map((row) => decode(Artifact, JSON.parse(row.document)));
    return { items, next: rows.length > 100 ? items.at(-1)!.id : null };
  }

  async put(id: string, input: ArtifactWrite): Promise<Artifact> {
    validateArtifactContent(input);
    const sql = this.sql;
    return this.runtime.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          const [blob] = yield* sql<{
            size: number;
          }>`SELECT length(content) AS size FROM blobs WHERE id = ${input.blob}`;
          if (!blob)
            return yield* Effect.fail(new ScopeError(400, "Upload the artifact content first."));
          const [current] = yield* sql<{
            document: string;
          }>`SELECT document FROM artifacts WHERE id = ${id}`;
          const previous = current ? decode(Artifact, JSON.parse(current.document)) : undefined;
          if ((previous?.revision ?? 0) !== input.expectedRevision)
            return yield* Effect.fail(
              new ScopeError(409, "Artifact changed. Read the current revision before updating."),
            );
          const { expectedRevision, ...metadata } = input;
          const now = new Date().toISOString();
          const artifact = decode(Artifact, {
            ...metadata,
            id,
            revision: expectedRevision + 1,
            size: blob.size,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          });
          yield* sql`INSERT INTO artifacts(id, revision, document) VALUES (${id}, ${artifact.revision}, ${JSON.stringify(artifact)})
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document`;
          return artifact;
        }),
      ),
    );
  }

  close(): Promise<void> {
    return this.runtime.dispose();
  }
}
