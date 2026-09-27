import { DatabaseMaintenance } from "@irudd-scope/sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, chmod, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Artifact,
  ArtifactWrite,
  type LiveEvent,
  Revision,
  BlobId,
  MAX_CONTENT_BYTES,
  ScopeError,
  decode,
  validateArtifactContent,
} from "@irudd-scope/protocol";
import { Tab, Uuid, tabArtifactId } from "../workspace/contract.ts";
import { DiagramDraft } from "../plugins/diagram/draft.ts";

const databaseRuntime = (filename: string) => ManagedRuntime.make(SqliteClient.layer({ filename }));

export const UPLOAD_GRACE_MS = 15 * 60_000;
export type LiveTab = {
  id: string;
  artifact_id: string | null;
  opened: number;
  document: string | null;
  position: number;
};

export class ArtifactStore {
  maintenance!: DatabaseMaintenance;
  onChanged: (event: LiveEvent) => void = () => {};
  private pendingMutations = Promise.resolve();
  private constructor(
    private readonly runtime: ReturnType<typeof databaseRuntime>,
    private readonly sql: SqliteClient.SqliteClient,
    readonly filename: string,
    private readonly checkpoint: (point: string) => Promise<void>,
  ) {}

  static async open(
    directory: string,
    checkpoint: (point: string) => Promise<void> = async () => {},
  ): Promise<ArtifactStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "scope.db");
    const runtime = databaseRuntime(filename);
    try {
      const sql = await runtime.runPromise(SqliteClient.SqliteClient);
      await chmod(filename, 0o600);
      await runtime.runPromise(sql`PRAGMA foreign_keys = ON`);
      await runtime.runPromise(sql`PRAGMA busy_timeout = 50`);
      const store = new ArtifactStore(runtime, sql, filename, checkpoint);
      await store.initialize(directory);
      await store.initializeLifecycle();
      store.maintenance = new DatabaseMaintenance(filename, "scope.db", () => store.reclaim());
      return store;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  private async run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    await this.maintenance?.idle();
    return this.runtime.runPromise(effect);
  }

  private mutate<A, E>(effect: Effect.Effect<A, E>, event: (result: A) => LiveEvent): Promise<A> {
    const task = this.pendingMutations.then(async () => {
      const result = await this.run(effect);
      this.onChanged(event(result));
      return result;
    });
    this.pendingMutations = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async initialize(directory: string): Promise<void> {
    const sql = this.sql;
    const [{ user_version: version }] = await this.run(
      sql<{ user_version: number }>`PRAGMA user_version`,
    );
    if (version > 3) throw new Error("The artifact database requires a newer Scope version.");
    if (version >= 2) return;

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

    await this.run(
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

  private async initializeLifecycle(): Promise<void> {
    const sql = this.sql;
    const [{ user_version: version }] = await this.run(
      sql<{ user_version: number }>`PRAGMA user_version`,
    );
    if (version === 3) return;
    await this.run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE live_tabs (
        id TEXT PRIMARY KEY, artifact_id TEXT, opened INTEGER NOT NULL CHECK (opened IN (0, 1)),
        document TEXT CHECK (document IS NULL OR json_valid(document)), position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ) STRICT`;
          yield* sql`CREATE INDEX live_tabs_artifact ON live_tabs(artifact_id)`;
          yield* sql`CREATE TABLE lifecycle (name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT`;
          yield* sql`CREATE TABLE tab_blobs (
        tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE,
        blob_id TEXT NOT NULL REFERENCES blobs(id), staged_until INTEGER NOT NULL,
        PRIMARY KEY(tab_id, blob_id)
      ) STRICT`;
          yield* sql`CREATE INDEX tab_blobs_blob ON tab_blobs(blob_id)`;
          yield* sql`CREATE TABLE tab_drafts (
        tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE,
        document TEXT NOT NULL CHECK (json_valid(document))
      ) STRICT`;
          yield* sql`CREATE TABLE artifacts_next (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
        document TEXT NOT NULL CHECK (json_valid(document)),
        tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, blob_id TEXT NOT NULL,
        FOREIGN KEY(tab_id, blob_id) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE
      ) STRICT`;
          const rows = yield* sql<{
            id: string;
            revision: number;
            document: string;
          }>`SELECT * FROM artifacts`;
          for (const row of rows) {
            const tabId = randomUUID();
            const artifact = decode(Artifact, JSON.parse(row.document));
            yield* sql`INSERT INTO live_tabs(id, artifact_id, opened, created_at) VALUES (${tabId}, ${row.id}, 0, ${Date.now()})`;
            yield* sql`INSERT INTO tab_blobs VALUES (${tabId}, ${artifact.blob}, 0)`;
            yield* sql`INSERT INTO artifacts_next VALUES (${row.id}, ${row.revision}, ${row.document}, ${tabId}, ${artifact.blob})`;
          }
          yield* sql`DROP TABLE artifacts`;
          yield* sql`ALTER TABLE artifacts_next RENAME TO artifacts`;
          yield* sql`CREATE INDEX artifacts_content ON artifacts(tab_id, blob_id)`;
          yield* sql`DELETE FROM blobs WHERE id NOT IN (SELECT blob_id FROM tab_blobs)`;
          yield* sql`CREATE TRIGGER remove_unused_blob AFTER DELETE ON tab_blobs BEGIN
        DELETE FROM blobs WHERE id = OLD.blob_id AND NOT EXISTS (SELECT 1 FROM tab_blobs WHERE blob_id = OLD.blob_id);
      END`;
          yield* sql`INSERT INTO lifecycle VALUES ('revision_floor', 1)`;
          yield* sql`INSERT INTO lifecycle SELECT 'max_revision', coalesce(max(revision), 0) FROM artifacts`;
          yield* sql`PRAGMA user_version = 3`;
        }),
      ),
    );
  }

  async tabs(): Promise<readonly LiveTab[]> {
    return this.run(
      this
        .sql<LiveTab>`SELECT id, artifact_id, opened, document, position FROM live_tabs ORDER BY position, rowid`,
    );
  }

  async importTabs(
    tabs: readonly Tab[],
    closed: readonly string[],
    drafts: readonly { artifact_id: string; document: string }[],
  ): Promise<void> {
    const sql = this.sql;
    await this.run(
      sql.withTransaction(
        Effect.gen(function* () {
          const imported = yield* sql`SELECT 1 FROM lifecycle WHERE name = 'workspace_imported'`;
          if (imported.length) return;
          const openArtifacts = new Set(
            tabs.flatMap((tab) => (tabArtifactId(tab) ? [tabArtifactId(tab)!] : [])),
          );
          for (const id of closed)
            if (!openArtifacts.has(id)) yield* sql`DELETE FROM live_tabs WHERE artifact_id = ${id}`;
          for (const [position, tab] of tabs.entries()) {
            const artifactId = tabArtifactId(tab);
            const [artifact] = artifactId
              ? yield* sql<{
                  tab_id: string;
                }>`SELECT tab_id FROM artifacts WHERE id = ${artifactId}`
              : [];
            if (artifactId && !artifact) continue;
            yield* sql`INSERT INTO live_tabs(id, artifact_id, opened, document, position, created_at)
          VALUES (${tab.id}, ${artifactId ?? null}, 1, ${JSON.stringify(tab)}, ${position}, ${Date.now()}) ON CONFLICT(id) DO NOTHING`;
            if (artifact && artifact.tab_id !== tab.id) {
              yield* sql`INSERT INTO tab_blobs SELECT ${tab.id}, blob_id, staged_until FROM tab_blobs WHERE tab_id = ${artifact.tab_id}`;
              yield* sql`UPDATE artifacts SET tab_id = ${tab.id} WHERE id = ${artifactId!}`;
              yield* sql`DELETE FROM live_tabs WHERE id = ${artifact.tab_id} AND opened = 0`;
            }
          }
          for (const draft of drafts) {
            const owners = yield* sql<{
              id: string;
            }>`SELECT id FROM live_tabs WHERE artifact_id = ${draft.artifact_id}`;
            if (!owners.length) continue;
            decode(DiagramDraft, JSON.parse(draft.document));
            for (const owner of owners)
              yield* sql`INSERT INTO tab_drafts VALUES (${owner.id}, ${draft.document}) ON CONFLICT(tab_id) DO NOTHING`;
          }
          if (closed.length)
            yield* sql`UPDATE lifecycle SET value = (SELECT value + 1 FROM lifecycle WHERE name = 'max_revision') WHERE name = 'revision_floor'`;
          yield* sql`INSERT INTO lifecycle VALUES ('workspace_imported', 1)`;
        }),
      ),
    );
  }

  async reserve(id: string, expectedRevision: number): Promise<string> {
    decode(Revision, expectedRevision);
    const sql = this.sql;
    return this.run(
      sql.withTransaction(
        Effect.gen(function* () {
          const [artifact] = yield* sql<{
            revision: number;
            tab_id: string;
          }>`SELECT revision, tab_id FROM artifacts WHERE id = ${id}`;
          if ((artifact?.revision ?? 0) !== expectedRevision)
            return yield* Effect.fail(
              new ScopeError(409, "Artifact changed. Read the current revision before updating."),
            );
          const [existing] = yield* sql<{
            id: string;
          }>`SELECT id FROM live_tabs WHERE artifact_id = ${id} LIMIT 1`;
          if (existing) {
            yield* sql`UPDATE live_tabs SET created_at = ${Date.now()} WHERE id = ${existing.id}`;
            return artifact?.tab_id ?? existing.id;
          }
          const tabId = randomUUID();
          yield* sql`INSERT INTO live_tabs(id, artifact_id, opened, created_at) VALUES (${tabId}, ${id}, 0, ${Date.now()})`;
          return tabId;
        }),
      ),
    );
  }

  async openTab(value: Tab): Promise<Tab> {
    const tab = decode(Tab, value);
    const artifactId = tabArtifactId(tab);
    let id = tab.id;
    if (artifactId) {
      const [row] = await this.run(
        this.sql<{ tab_id: string }>`SELECT tab_id FROM artifacts WHERE id = ${artifactId}`,
      );
      if (!row) throw new ScopeError(404, "This artifact was deleted.");
      id = row.tab_id;
    } else {
      await this.run(
        this
          .sql`INSERT INTO live_tabs(id, artifact_id, opened, created_at) VALUES (${id}, NULL, 0, ${Date.now()}) ON CONFLICT(id) DO NOTHING`,
      );
    }
    const opened = { ...tab, id };
    const rows = await this.run(
      this.sql`UPDATE live_tabs SET opened = 1, document = ${JSON.stringify(opened)},
          position = CASE WHEN opened = 0 THEN (SELECT coalesce(max(position), -1) + 1 FROM live_tabs WHERE opened = 1) ELSE position END
          WHERE id = ${id} AND artifact_id IS ${artifactId ?? null} RETURNING id`,
    );
    if (!rows.length) throw new ScopeError(404, "This tab is closed.");
    return opened;
  }

  async saveTabs(tabs: readonly Tab[]): Promise<void> {
    const sql = this.sql;
    await this.run(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const [position, tab] of tabs.entries()) {
            yield* sql`UPDATE live_tabs SET document = ${JSON.stringify(tab)}, position = ${position} WHERE id = ${tab.id} AND opened = 1 AND artifact_id IS ${tabArtifactId(tab) ?? null}`;
          }
        }),
      ),
    );
  }

  async removeArtifact(id: string): Promise<boolean> {
    const sql = this.sql;
    const checkpoint = this.checkpoint;
    return this.mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`SELECT id FROM live_tabs WHERE artifact_id = ${id}`;
          yield* sql`DELETE FROM live_tabs WHERE artifact_id = ${id}`;
          yield* Effect.promise(() => checkpoint("inside-close-transaction"));
          if (rows.length)
            yield* sql`UPDATE lifecycle SET value = (SELECT value + 1 FROM lifecycle WHERE name = 'max_revision') WHERE name = 'revision_floor'`;
          return rows.length > 0;
        }),
      ),
      () => ({ type: "deleted", id }),
    );
  }

  async removeTab(id: string): Promise<string | null> {
    const [tab] = await this.run(this.sql<LiveTab>`SELECT * FROM live_tabs WHERE id = ${id}`);
    if (tab?.artifact_id) {
      await this.removeArtifact(tab.artifact_id);
      return tab.artifact_id;
    }
    await this.run(this.sql`DELETE FROM live_tabs WHERE id = ${id}`);
    return null;
  }

  async diagramDraft(id: string): Promise<DiagramDraft | null> {
    decode(Uuid, id);
    const [row] = await this.run(
      this.sql<{ document: string }>`SELECT document FROM tab_drafts WHERE tab_id = ${id}`,
    );
    return row ? decode(DiagramDraft, JSON.parse(row.document)) : null;
  }

  async saveDiagramDraft(id: string, value: unknown): Promise<void> {
    decode(Uuid, id);
    const draft = decode(DiagramDraft, value);
    await this.run(this.sql`INSERT INTO tab_drafts(tab_id, document)
      SELECT id, ${JSON.stringify(draft)} FROM live_tabs WHERE id = ${id}
      ON CONFLICT(tab_id) DO UPDATE SET document = excluded.document`);
  }

  async reclaim(now = Date.now()): Promise<number> {
    const sql = this.sql;
    return this.run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM tab_blobs WHERE staged_until <= ${now} AND NOT EXISTS (SELECT 1 FROM artifacts WHERE artifacts.tab_id = tab_blobs.tab_id AND artifacts.blob_id = tab_blobs.blob_id)`;
          yield* sql`DELETE FROM live_tabs WHERE opened = 0 AND created_at <= ${now - UPLOAD_GRACE_MS} AND NOT EXISTS (SELECT 1 FROM artifacts WHERE artifacts.tab_id = live_tabs.id) AND NOT EXISTS (SELECT 1 FROM tab_blobs WHERE tab_blobs.tab_id = live_tabs.id)`;
          const [row] = yield* sql<{
            bytes: number;
          }>`SELECT coalesce(sum(length(content)), 0) AS bytes FROM blobs WHERE id NOT IN (SELECT blob_id FROM artifacts)`;
          return row.bytes;
        }),
      ),
    );
  }

  async upload(tabId: string, chunks: AsyncIterable<Uint8Array>): Promise<string> {
    decode(Uuid, tabId);
    const rows = await this.run(
      this.sql`UPDATE live_tabs SET created_at = ${Date.now()} WHERE id = ${tabId} RETURNING id`,
    );
    if (!rows.length) throw new ScopeError(404, "Create the tab before uploading content.");
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
    const sql = this.sql;
    await this.run(
      sql.withTransaction(
        Effect.gen(function* () {
          const alive = yield* sql`SELECT id FROM live_tabs WHERE id = ${tabId}`;
          if (!alive.length) return yield* Effect.fail(new ScopeError(404, "This tab is closed."));
          yield* sql`INSERT INTO blobs(id, content) VALUES (${id}, ${bytes}) ON CONFLICT(id) DO NOTHING`;
          yield* sql`INSERT INTO tab_blobs VALUES (${tabId}, ${id}, ${Date.now() + UPLOAD_GRACE_MS}) ON CONFLICT(tab_id, blob_id) DO UPDATE SET staged_until = excluded.staged_until`;
        }),
      ),
    );
    return id;
  }

  async content(id: string): Promise<Buffer> {
    decode(BlobId, id);
    const [row] = await this.run(
      this.sql<{ content: Uint8Array }>`SELECT content FROM blobs WHERE id = ${id}`,
    );
    if (!row) throw new ScopeError(404, "Artifact content not found.");
    return Buffer.from(row.content);
  }

  async get(id: string): Promise<Artifact> {
    const [row] = await this.run(
      this.sql<{ document: string }>`SELECT document FROM artifacts WHERE id = ${id}`,
    );
    if (!row) throw new ScopeError(404, "Artifact not found.");
    return decode(Artifact, JSON.parse(row.document));
  }

  async list(after = ""): Promise<{ items: Artifact[]; next: string | null }> {
    const rows = await this.run(
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
    return this.mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const [tab] =
            yield* sql`SELECT id FROM live_tabs WHERE id = ${input.tabId} AND artifact_id = ${id}`;
          if (!tab)
            return yield* Effect.fail(
              new ScopeError(409, "This tab was closed. Create a new publication explicitly."),
            );
          const [blob] = yield* sql<{
            size: number;
          }>`SELECT length(content) AS size FROM blobs JOIN tab_blobs ON tab_blobs.blob_id = blobs.id WHERE blobs.id = ${input.blob} AND tab_blobs.tab_id = ${input.tabId}`;
          if (!blob)
            return yield* Effect.fail(new ScopeError(400, "Upload the content to this tab first."));
          const [current] = yield* sql<{
            document: string;
          }>`SELECT document FROM artifacts WHERE id = ${id}`;
          const previous = current ? decode(Artifact, JSON.parse(current.document)) : undefined;
          if ((previous?.revision ?? 0) !== input.expectedRevision)
            return yield* Effect.fail(
              new ScopeError(409, "Artifact changed. Read the current revision before updating."),
            );
          const { expectedRevision, tabId, ...metadata } = input;
          const [counter] = yield* sql<{
            value: number;
          }>`SELECT value FROM lifecycle WHERE name = 'revision_floor'`;
          const revision = previous ? expectedRevision + 1 : counter.value;
          yield* sql`UPDATE lifecycle SET value = max(value, ${revision}) WHERE name = 'max_revision'`;
          const now = new Date().toISOString();
          const artifact = decode(Artifact, {
            ...metadata,
            id,
            revision,
            size: blob.size,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          });
          yield* sql`INSERT INTO artifacts(id, revision, document, tab_id, blob_id) VALUES (${id}, ${revision}, ${JSON.stringify(artifact)}, ${tabId}, ${input.blob})
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document, blob_id = excluded.blob_id`;
          return artifact;
        }),
      ),
      (artifact) => ({ type: "artifact", artifact }),
    );
  }

  async close(): Promise<void> {
    await this.maintenance?.close();
    await this.runtime.dispose();
  }
}
