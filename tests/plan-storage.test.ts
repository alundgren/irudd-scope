import { expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";

const planTables = [
  "plan_state",
  "plan_revisions",
  "plan_images",
  "plan_records",
  "plan_receipts",
  "plan_drafts",
];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function publish(store: ArtifactStore, html: string, previousRevision = 0) {
  const id = "storage-plan-artifact";
  const tabId = await store.reserve(id, previousRevision);
  const blob = await store.upload(
    tabId,
    (async function* () {
      yield Buffer.from(html);
    })(),
  );
  return store.put(id, {
    tabId,
    blob,
    expectedRevision: previousRevision,
    name: "storage-plan",
    title: "A plan",
    kind: "plan",
    mediaType: "text/html",
    fileName: "plan.html",
  });
}

test("upgrading removes plan feedback and old versions while keeping the current plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-storage-"));
  try {
    let store = await ArtifactStore.open(directory);
    const first = await publish(store, "<h1>First</h1>");
    const current = await publish(store, "<h1>Current</h1>", first.revision);
    const [tab] = await store.tabs();
    await store.close();

    // Recreate the records a schema 14 database kept for this plan.
    const oldHtml = Buffer.from("<h1>First</h1>");
    const screenshot = Buffer.from("synthetic screenshot bytes");
    const db = new DatabaseSync(join(directory, "scope.db"));
    try {
      db.exec(
        "CREATE TABLE plan_state(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0)) STRICT;" +
          "CREATE TABLE plan_revisions(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, revision INTEGER NOT NULL, blob_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, PRIMARY KEY(tab_id, revision), FOREIGN KEY(tab_id, blob_id) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE) STRICT;" +
          "CREATE TABLE plan_images(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, blob_id TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, PRIMARY KEY(tab_id, blob_id), FOREIGN KEY(tab_id, blob_id) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE) STRICT;" +
          "CREATE TABLE plan_records(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('comment', 'round', 'response')), id TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), PRIMARY KEY(tab_id, id)) STRICT;" +
          "CREATE TABLE plan_receipts(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tab_id, request_id)) STRICT;" +
          "CREATE TABLE plan_drafts(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;",
      );
      for (const bytes of [oldHtml, screenshot]) {
        db.prepare("INSERT OR IGNORE INTO blobs(id, content) VALUES (?, ?)").run(
          sha256(bytes),
          bytes,
        );
        db.prepare("INSERT OR IGNORE INTO tab_blobs VALUES (?, ?, 0)").run(tab.id, sha256(bytes));
      }
      db.prepare("INSERT INTO plan_state VALUES (?, 3)").run(tab.id);
      db.prepare("INSERT INTO plan_revisions VALUES (?, 1, ?, 'A plan', '2026-10-01', NULL)").run(
        tab.id,
        sha256(oldHtml),
      );
      db.prepare("INSERT INTO plan_revisions VALUES (?, 2, ?, 'A plan', '2026-10-02', NULL)").run(
        tab.id,
        current.blob,
      );
      db.prepare("INSERT INTO plan_images VALUES (?, ?, 1, 1)").run(tab.id, sha256(screenshot));
      db.prepare("INSERT INTO plan_records VALUES (?, 'comment', 'comment-1', ?)").run(
        tab.id,
        JSON.stringify({ text: "Clarify the API" }),
      );
      db.prepare("INSERT INTO plan_receipts VALUES (?, 'request-1', 'payload')").run(tab.id);
      db.prepare("INSERT INTO plan_drafts VALUES (?, ?)").run(tab.id, JSON.stringify({}));
      db.exec("PRAGMA user_version = 14");
    } finally {
      db.close();
    }

    store = await ArtifactStore.open(directory);
    expect(await store.named("storage-plan")).toEqual(current);
    expect(Buffer.from(await store.content(current.blob)).toString()).toBe("<h1>Current</h1>");
    await store.reclaim(Date.now() + 60 * 60_000);
    await store.close();

    const upgraded = new DatabaseSync(join(directory, "scope.db"));
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(15);
      const tables = upgraded
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      for (const table of planTables) expect(tables).not.toContain(table);
      const blobs = upgraded
        .prepare("SELECT id FROM blobs")
        .all()
        .map((row) => row.id);
      expect(blobs).toEqual([current.blob]);
    } finally {
      upgraded.close();
    }

    store = await ArtifactStore.open(directory);
    expect(Buffer.from(await store.content(current.blob)).toString()).toBe("<h1>Current</h1>");
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("republishing a plan keeps only its current HTML bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-storage-"));
  const store = await ArtifactStore.open(directory);
  try {
    const first = await publish(store, "<h1>First</h1>");
    const current = await publish(store, "<h1>Second</h1>", first.revision);
    expect(current).toMatchObject({ id: first.id, kind: "plan", name: "storage-plan" });
    await store.reclaim(Date.now() + 60 * 60_000);
    expect(await store.reclaim(Date.now() + 60 * 60_000)).toBe(0);
    await expect(store.content(sha256(Buffer.from("<h1>First</h1>")))).rejects.toThrow();
    expect(Buffer.from(await store.content(current.blob)).toString()).toBe("<h1>Second</h1>");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
