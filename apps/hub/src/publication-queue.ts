import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ArtifactId,
  ArtifactWrite,
  BUFFERED_TAB_TTL_MS,
  HubQueue,
  MAX_BUFFERED_TABS,
  QueuedPublication,
  ScopeError,
  decode,
  validateArtifactContent,
} from "@irudd-scope/protocol";

export type BufferedTab = {
  id: string;
  tabId: string;
  expectedRevision: number;
  expiresAt: number;
  document: string | null;
  writing: number;
  error: string | null;
};

export class PublicationQueue {
  generation = 0;
  constructor(
    private readonly database: DatabaseSync,
    private readonly now = Date.now,
  ) {}

  expire() {
    this.database.prepare("DELETE FROM publication_queue WHERE expires_at <= ?").run(this.now());
  }
  get(id: string): BufferedTab | undefined {
    this.expire();
    return this.database
      .prepare(`SELECT id, tab_id AS tabId, expected_revision AS expectedRevision,
      expires_at AS expiresAt, document, writing, error FROM publication_queue WHERE id = ?`)
      .get(id) as BufferedTab | undefined;
  }
  hasTab(tabId: string) {
    this.expire();
    return Boolean(
      this.database.prepare("SELECT id FROM publication_queue WHERE tab_id = ?").get(tabId),
    );
  }
  reserve(id: string, expectedRevision: number) {
    decode(ArtifactId, id);
    this.expire();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.get(id);
      if (previous) {
        if (previous.expectedRevision !== expectedRevision || previous.document)
          throw new ScopeError(
            409,
            "This artifact already has a buffered publication. Inspect the hub queue before retrying.",
          );
        this.database.exec("COMMIT");
        return previous.tabId;
      }
      const count = this.database.prepare("SELECT count(*) AS count FROM publication_queue").get()!
        .count as number;
      if (count >= MAX_BUFFERED_TABS)
        throw new ScopeError(
          503,
          "The hub queue is full at 50 tabs. Connect Scope or discard a queued publication.",
        );
      const tabId = randomUUID();
      this.database
        .prepare(`INSERT INTO publication_queue(id, tab_id, expected_revision, expires_at)
        VALUES (?, ?, ?, ?)`)
        .run(id, tabId, expectedRevision, this.now() + BUFFERED_TAB_TTL_MS);
      this.database.exec("COMMIT");
      return tabId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  upload(tabId: string, bytes: Buffer) {
    this.expire();
    const blob = createHash("sha256").update(bytes).digest("hex");
    const result = this.database
      .prepare(`UPDATE publication_queue SET content = ?, blob = ?
      WHERE tab_id = ? AND document IS NULL`)
      .run(bytes, blob, tabId);
    if (!result.changes)
      throw new ScopeError(409, "The buffered tab expired or already has a complete publication.");
    return blob;
  }
  put(id: string, input: ArtifactWrite): QueuedPublication {
    validateArtifactContent(input);
    const item = this.get(id);
    if (!item || item.tabId !== input.tabId || item.expectedRevision !== input.expectedRevision)
      throw new ScopeError(409, "The buffered tab expired or does not match this publication.");
    const content = this.database
      .prepare("SELECT blob FROM publication_queue WHERE id = ?")
      .get(id)!;
    if (content.blob !== input.blob)
      throw new ScopeError(400, "Upload the content to this buffered tab first.");
    const document = JSON.stringify(input);
    if (item.document && item.document !== document)
      throw new ScopeError(
        409,
        "A complete buffered publication cannot be replaced. Discard it explicitly first.",
      );
    this.database
      .prepare("UPDATE publication_queue SET document = ? WHERE id = ?")
      .run(document, id);
    return decode(QueuedPublication, {
      id,
      queued: true,
      expiresAt: new Date(item.expiresAt).toISOString(),
    });
  }
  next(): BufferedTab | undefined {
    this.expire();
    const row = this.database
      .prepare(`SELECT id FROM publication_queue WHERE document IS NOT NULL
      AND error IS NULL ORDER BY expires_at, rowid LIMIT 1`)
      .get();
    return row ? this.get(row.id as string) : undefined;
  }
  content(id: string): Buffer {
    const row = this.database.prepare("SELECT content FROM publication_queue WHERE id = ?").get(id);
    if (!row?.content) throw new ScopeError(404, "The buffered tab expired or was discarded.");
    return Buffer.from(row.content as Uint8Array);
  }
  markWriting(id: string) {
    this.database.prepare("UPDATE publication_queue SET writing = 1 WHERE id = ?").run(id);
  }
  block(id: string, tabId: string, error: string) {
    this.database
      .prepare("UPDATE publication_queue SET error = ? WHERE id = ? AND tab_id = ?")
      .run(error.slice(0, 1024), id, tabId);
  }
  remove(id: string, tabId?: string) {
    return Boolean(
      this.database
        .prepare("DELETE FROM publication_queue WHERE id = ? AND (? IS NULL OR tab_id = ?)")
        .run(id, tabId ?? null, tabId ?? null).changes,
    );
  }
  clear() {
    this.database.exec("DELETE FROM publication_queue");
    this.generation++;
  }
  snapshot(): HubQueue {
    this.expire();
    const rows = this.database
      .prepare(
        `SELECT id, expires_at, document, error FROM publication_queue ORDER BY expires_at, rowid`,
      )
      .all();
    return decode(HubQueue, {
      limit: MAX_BUFFERED_TABS,
      items: rows.map((row) => ({
        id: row.id,
        expiresAt: new Date(row.expires_at as number).toISOString(),
        ...(row.document
          ? { title: decode(ArtifactWrite, JSON.parse(row.document as string)).title }
          : {}),
        status: row.error ? "blocked" : row.document ? "queued" : "staging",
        ...(row.error ? { error: row.error } : {}),
      })),
    });
  }
}
