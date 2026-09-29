import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { decode } from "@irudd-scope/protocol";
import {
  Share,
  SharingStatus,
  SHARE_LIFETIME_MS,
  type ShareWrite,
} from "@irudd-scope/protocol/sharing";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export class SharingStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;");
    const version = this.db.prepare("PRAGMA user_version").get()!.user_version as number;
    if (version > 1) throw new Error("The sharing database requires a newer service.");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS stopped (id TEXT PRIMARY KEY, time INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)),
        operation TEXT NOT NULL, fingerprint TEXT NOT NULL, media_type TEXT NOT NULL,
        token TEXT NOT NULL, content BLOB
      ) STRICT; PRAGMA user_version=1;`);
    if (!this.getSetting("id")) this.setSetting("id", randomUUID());
    if (!this.getSetting("name")) this.setSetting("name", "Sharing service");
  }
  getSetting(name: string): string | undefined {
    return this.db.prepare("SELECT value FROM settings WHERE name=?").get(name)?.value as
      | string
      | undefined;
  }
  setSetting(name: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      )
      .run(name, value);
  }
  pairing(now: number) {
    if (this.getSetting("desktop"))
      throw new Error("Remove the current desktop pairing before pairing another desktop.");
    const token = newToken();
    this.setSetting("pair", JSON.stringify({ hash: digest(token), expiresAt: now + 10 * 60_000 }));
    return token;
  }
  pair(token: string, name: string, now: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = JSON.parse(this.getSetting("pair") ?? "null") as {
        hash: string;
        expiresAt: number;
      } | null;
      if (
        this.getSetting("desktop") ||
        !pending ||
        now >= pending.expiresAt ||
        !this.matches(token, pending.hash)
      )
        throw new Error("Pairing expired or was already used. Generate a fresh pairing URL.");
      const secret = newToken();
      this.setSetting("desktop", digest(secret));
      this.setSetting("desktopName", name);
      this.db.prepare("DELETE FROM settings WHERE name='pair'").run();
      this.db.exec("COMMIT");
      return { id: this.getSetting("id")!, name: this.getSetting("name")!, token: secret };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private matches(token: string, hash: string) {
    return (
      /^[a-f0-9]{64}$/.test(hash) &&
      timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(hash, "hex"))
    );
  }
  authorized(token: string) {
    return this.matches(token, this.getSetting("desktop") ?? "");
  }
  unpair() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const hash = this.getSetting("desktop");
      if (hash) this.setSetting("revoked", hash);
      this.db.prepare("DELETE FROM settings WHERE name IN ('desktop','desktopName','pair')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  revoked(token: string) {
    return this.matches(token, this.getSetting("revoked") ?? "");
  }
  stopped(id: string) {
    return !!this.db.prepare("SELECT id FROM stopped WHERE id=?").get(id);
  }
  rememberStop(id: string) {
    this.db.prepare("DELETE FROM stopped WHERE time < ?").run(Date.now() - SHARE_LIFETIME_MS);
    this.db.prepare("INSERT OR REPLACE INTO stopped VALUES (?,?)").run(id, Date.now());
  }
  list(): Share[] {
    return this.db
      .prepare("SELECT document FROM shares ORDER BY rowid DESC LIMIT 128")
      .all()
      .map((row) => decode(Share, JSON.parse(row.document as string)));
  }
  status(): SharingStatus {
    return {
      version: 1,
      id: this.getSetting("id")!,
      name: this.getSetting("name")!,
      shares: this.list(),
    };
  }
  record(id: string) {
    const row = this.db.prepare("SELECT * FROM shares WHERE id=?").get(id);
    if (!row) return undefined;
    return {
      share: decode(Share, JSON.parse(row.document as string)),
      operation: row.operation as string,
      fingerprint: row.fingerprint as string,
      mediaType: row.media_type as string,
      token: row.token as string,
      content: row.content === null ? null : Buffer.from(row.content as Uint8Array),
    };
  }
  create(id: string, write: ShareWrite, bytes: Buffer, fingerprint: string, now: number) {
    this.db
      .prepare(
        "DELETE FROM shares WHERE content IS NULL AND rowid NOT IN (SELECT rowid FROM shares WHERE content IS NULL ORDER BY rowid DESC LIMIT 100)",
      )
      .run();
    const share: Share = {
      id,
      tabId: write.tabId,
      operationId: write.operationId,
      title: write.title,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + SHARE_LIFETIME_MS,
      status: "starting",
      url: null,
    };
    this.db
      .prepare("INSERT INTO shares VALUES (?,?,?,?,?,?,?)")
      .run(
        id,
        JSON.stringify(share),
        write.operationId,
        fingerprint,
        write.mediaType,
        newToken(),
        bytes,
      );
    return share;
  }
  refresh(share: Share, write: ShareWrite, bytes: Buffer, fingerprint: string, now: number) {
    const next = {
      ...share,
      title: write.title,
      operationId: write.operationId,
      revision: share.revision + 1,
      updatedAt: now,
    };
    this.db
      .prepare(
        "UPDATE shares SET document=?, operation=?, fingerprint=?, media_type=?, content=? WHERE id=?",
      )
      .run(JSON.stringify(next), write.operationId, fingerprint, write.mediaType, bytes, share.id);
    return next;
  }
  set(share: Share) {
    this.db
      .prepare(
        "UPDATE shares SET document=?, content=CASE WHEN ? THEN content ELSE NULL END WHERE id=?",
      )
      .run(
        JSON.stringify(decode(Share, share)),
        ["starting", "active"].includes(share.status) ? 1 : 0,
        share.id,
      );
  }
  recover() {
    for (const share of this.list())
      if (["starting", "active"].includes(share.status))
        this.set({ ...share, status: "interrupted" });
    this.db
      .prepare(
        "UPDATE shares SET content=NULL WHERE json_extract(document,'$.status') NOT IN ('starting','active')",
      )
      .run();
    this.db
      .prepare(
        "DELETE FROM shares WHERE content IS NULL AND rowid NOT IN (SELECT rowid FROM shares ORDER BY rowid DESC LIMIT 100)",
      )
      .run();
  }
  close() {
    this.db.close();
  }
}
