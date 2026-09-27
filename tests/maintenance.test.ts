import { afterEach, expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DatabaseMaintenance,
  databaseBytes,
  SHRINK_INTERVAL_MS,
  SHRINK_THRESHOLD,
} from "../packages/sqlite/src/maintenance.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "scope-maintenance-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("automatic shrinking uses each database's size and last success, including overdue restart, retry, and manual bypass", async () => {
  const filename = join(await temp(), "hub.db");
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE keep (id TEXT PRIMARY KEY, value TEXT); INSERT INTO keep VALUES ('pairing', 'synthetic-hash');",
  );
  let now = Date.parse("2026-01-01T00:00:00Z");
  let size = SHRINK_THRESHOLD - 1;
  let freeSpace = 1_000_000_000;
  const make = () =>
    new DatabaseMaintenance(
      filename,
      "hub.db",
      undefined,
      () => now,
      async () => ({ main: size, wal: 0, allocated: size }),
      async () => freeSpace,
    );
  let maintenance = make();
  cleanup.push(async () => {
    await maintenance.close();
    db.close();
  });
  expect((await maintenance.run(false)).status).toBe("skipped");
  size++;
  expect((await maintenance.run(false)).status).toBe("skipped");
  size++;
  const first = await maintenance.run(false);
  expect(first.status).toBe("completed");
  expect(first.lastSuccess).toBe(new Date(now).toISOString());
  now += SHRINK_INTERVAL_MS - 1;
  expect((await maintenance.run(false)).status).toBe("skipped");
  await maintenance.close();
  maintenance = make();
  expect((await maintenance.run(false)).status).toBe("skipped");
  now += 1;
  freeSpace = 0;
  const noSpace = await maintenance.run(false);
  expect(noSpace.status).toBe("deferred");
  expect(noSpace.lastSuccess).toBe(first.lastSuccess);
  freeSpace = 1_000_000_000;
  db.exec("BEGIN IMMEDIATE");
  const busy = await maintenance.run(false);
  db.exec("ROLLBACK");
  expect(busy.status).toBe("deferred");
  expect(busy.lastSuccess).toBe(first.lastSuccess);
  const overdue = await maintenance.run(false);
  expect(overdue.status).toBe("completed");
  expect(overdue.lastSuccess).toBe(new Date(now).toISOString());
  size = 0;
  now += 10;
  expect((await maintenance.run(false)).status).toBe("skipped");
  const manual = await maintenance.run(true);
  expect(manual.status).toBe("completed");
  expect(manual.lastSuccess).toBe(new Date(now).toISOString());
  expect(db.prepare("SELECT value FROM keep").get()?.value).toBe("synthetic-hash");
  expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
});

test("desktop shrink reclaims more than 100 MB, preserves live bytes and settings, and returns both database receipts", async () => {
  const directory = await temp();
  const desktop = new DesktopStore(directory);
  await desktop.load();
  cleanup.push(() => desktop.close());
  await desktop.saveSettings({ appearance: "dark" });
  let lifecycle: DesktopLifecycle;
  const server = await startArtifactServer({
    directory: join(directory, "artifacts"),
    token: "synthetic-maintenance-publishing-token",
    port: 0,
    initialize: async (store) => {
      lifecycle = new DesktopLifecycle(store, desktop);
      await lifecycle.recover();
    },
    deleteArtifact: (id) => lifecycle.deleteArtifact(id),
    shrink: (timeoutMs) => lifecycle.shrink(timeoutMs),
    maintenanceStatus: () =>
      [lifecycle.artifacts.maintenance.latest(), desktop.maintenance.latest()].filter(
        (value) => value !== null,
      ),
  });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, "synthetic-maintenance-publishing-token");
  const baseline = await client.shrink();
  expect(baseline.databases.map((entry) => entry.database)).toEqual(["scope.db", "desktop.db"]);
  expect(baseline.databases.every((entry) => entry.status === "completed")).toBe(true);
  const metadata = {
    title: "Synthetic bytes",
    kind: "file",
    mediaType: "application/octet-stream",
    fileName: "synthetic.bin",
    expectedRevision: 0,
  };
  const surviving = Buffer.alloc(1024 * 1024, 17);
  await client.publish("survivor", metadata, surviving);
  for (let index = 0; index < 5; index++)
    await client.publish(`growth-${index}`, metadata, Buffer.alloc(24 * 1024 * 1024, index + 60));
  const large = await databaseBytes(server.store.filename);
  expect(large.main + large.wal).toBeGreaterThan(SHRINK_THRESHOLD);
  for (let index = 0; index < 5; index++) await client.delete(`growth-${index}`);
  const turns: number[] = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    turns.push(now - previous);
    previous = now;
  }, 5);
  let receipt;
  try {
    receipt = await client.shrink();
  } finally {
    clearInterval(timer);
  }
  expect(receipt.databases.every((entry) => entry.status === "completed")).toBe(true);
  expect(turns.length).toBeGreaterThan(0);
  expect(Math.max(...turns)).toBeLessThan(250);
  expect(Buffer.from(await client.content("survivor"))).toEqual(surviving);
  expect(desktop.settings().appearance).toBe("dark");
  const scope = receipt.databases[0];
  expect(scope.after.main + scope.after.wal).toBeLessThan(2 * 1024 * 1024);
  expect(scope.after).toEqual(await databaseBytes(server.store.filename));
  expect((await client.maintenanceStatus()).databases).toHaveLength(2);
  await client.delete("survivor");
  const empty = await client.shrink();
  for (const [index, result] of empty.databases.entries()) {
    expect(result.after.main + result.after.wal).toBeLessThanOrEqual(
      baseline.databases[index].after.main + baseline.databases[index].after.wal + 32_768,
    );
  }
  const db = new DatabaseSync(server.store.filename);
  try {
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
}, 60_000);

test("an interrupted shrink has no success timestamp and can be retried without losing bytes", async () => {
  const filename = join(await temp(), "scope.db");
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE content(id INTEGER PRIMARY KEY, bytes BLOB); INSERT INTO content VALUES (1, zeroblob(16777216));",
  );
  const maintenance = new DatabaseMaintenance(filename, "scope.db");
  cleanup.push(async () => {
    await maintenance.close();
    db.close();
  });
  const interrupted = await maintenance.run(true, 1);
  expect(interrupted.status).toBe("deferred");
  expect(interrupted.lastSuccess).toBeNull();
  const complete = await maintenance.run();
  expect(complete.status).toBe("completed");
  expect(db.prepare("SELECT length(bytes) AS size FROM content").get()?.size).toBe(
    16 * 1024 * 1024,
  );
  expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
});

test("a failed file-size read releases waiting operations and does not record a successful shrink", async () => {
  const filename = join(await temp(), "scope.db");
  let measurements = 0;
  const maintenance = new DatabaseMaintenance(
    filename,
    "scope.db",
    undefined,
    Date.now,
    async () => {
      if (++measurements === 2) throw new Error("Synthetic file-size failure");
      return databaseBytes(filename);
    },
  );
  cleanup.push(() => maintenance.close());
  const failed = await maintenance.run();
  expect(failed.status).toBe("failed");
  expect(failed.lastSuccess).toBeNull();
  await maintenance.idle();
  const db = new DatabaseSync(filename);
  try {
    expect(
      db.prepare("SELECT value FROM maintenance WHERE name = 'last_success'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
  expect((await maintenance.run()).status).toBe("completed");
});
