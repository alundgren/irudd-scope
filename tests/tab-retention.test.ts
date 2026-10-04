import { afterEach, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import {
  TEMPORARY_RETENTION_MS as DAY,
  TRASH_RETENTION_MS,
} from "../apps/desktop/src/workspace/retention.ts";
import type { DiagramDraft } from "../apps/desktop/src/plugins/diagram/draft.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-retention-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const desktop = new DesktopStore(directory);
  await desktop.load();
  cleanup.push(() => desktop.close());
  let lifecycle!: DesktopLifecycle;
  const server = await startArtifactServer({
    directory: join(directory, "artifacts"),
    port: 0,
    token: "synthetic-retention-token",
    initialize: async (artifacts) => {
      lifecycle = new DesktopLifecycle(artifacts, desktop);
      await lifecycle.recover();
    },
    deleteArtifact: (id) => lifecycle.deleteArtifact(id),
  });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, "synthetic-retention-token");
  const publish = async (id: string) => {
    const artifact = await client.publish(
      id,
      {
        title: id,
        name: id,
        kind: "text",
        mediaType: "text/plain",
        fileName: "note.txt",
        expectedRevision: 0,
      },
      Buffer.from("Shared content"),
    );
    const workspace = await lifecycle.workspace();
    const tab = await lifecycle.openTab(
      {
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        title: id,
        type: "file",
        state: { version: 1, data: { artifactId: id } },
      },
      artifact.revision,
    );
    if (!tab) throw new Error("Publication did not open.");
    return tab;
  };
  return { directory, server, client, lifecycle, publish };
}
const draft: DiagramDraft = {
  version: 1,
  content: '{"type":"excalidraw","elements":[],"files":{}}',
  revision: 1,
  dirty: false,
  messages: [],
  intent: "Keep this prompt",
  chatOpen: true,
  viewport: { zoom: 1, scrollX: 20, scrollY: 30 },
};

test("hidden temporary tabs get a day, visible and permanent tabs survive, and trash retains content for seven days", async () => {
  const f = await fixture();
  const hidden = await f.publish("hidden");
  const visible = await f.publish("visible");
  const permanent = await f.publish("permanent");
  const store = f.server.store;
  const now = Date.now();
  await store.markTabsVisible([hidden.id, visible.id, permanent.id], now);
  await store.setTabPermanent(permanent.id, true, now);
  await store.saveDiagramDraft(hidden.id, draft);
  const saved = await f.lifecycle.workspace();
  await f.lifecycle.checkRetention([visible.id], now + DAY - 1);
  expect((await f.lifecycle.workspace()).tabs).toHaveLength(3);
  await f.lifecycle.checkRetention([visible.id], now + DAY);
  expect((await f.lifecycle.workspace()).tabs.map((tab) => tab.id)).toEqual([
    visible.id,
    permanent.id,
  ]);
  const trash = (await store.retainedTabs()).find((entry) => entry.tab.id === hidden.id)!;
  expect(trash.trashedAt).toBe(now + DAY);
  expect(await store.diagramDraft(hidden.id)).toEqual(draft);
  expect(Buffer.from(await f.client.content("hidden")).toString()).toBe("Shared content");
  await f.lifecycle.saveWorkspace(saved);
  expect(await f.lifecycle.openTab(hidden)).toBeNull();
  await expect(
    f.client.publish(
      "hidden",
      {
        title: "Late update",
        kind: "text",
        mediaType: "text/plain",
        fileName: "note.txt",
        expectedRevision: 1,
      },
      Buffer.from("Late"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.replaceContent("hidden", 1, "Late editor", Buffer.from("Late")),
  ).rejects.toMatchObject({ status: 404 });
  await f.lifecycle.checkRetention([visible.id], now + DAY + TRASH_RETENTION_MS - 1);
  expect(await f.client.get("hidden")).toMatchObject({ name: "hidden" });
  await f.lifecycle.checkRetention([visible.id], now + DAY + TRASH_RETENTION_MS);
  await expect(f.client.get("hidden")).rejects.toMatchObject({ status: 404 });
  expect(await store.diagramDraft(hidden.id)).toBeNull();
  expect(Buffer.from(await f.client.content("visible")).toString()).toBe("Shared content");
  const db = new DatabaseSync(store.filename);
  try {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

test("restore keeps permanence and drafts, resets the day, and stale empty-trash confirmation cannot delete a restored tab", async () => {
  const f = await fixture();
  const first = await f.publish("first");
  const second = await f.publish("second");
  await f.lifecycle.setTabPermanent(first.id, true);
  await f.server.store.saveDiagramDraft(first.id, draft);
  await f.lifecycle.closeTab(first.id);
  const entry = (await f.server.store.retainedTabs()).find((entry) => entry.tab.id === first.id)!;
  const confirmation = [{ id: first.id, trashedAt: entry.trashedAt! }];
  const restored = await f.lifecycle.restoreTab(first.id);
  expect(restored.id).toBe(first.id);
  expect((await f.lifecycle.workspace()).tabs.map((tab) => tab.id)).toEqual([second.id, first.id]);
  expect((await f.server.store.retainedTabs()).at(-1)).toMatchObject({
    permanent: true,
    trashedAt: null,
  });
  expect(await f.server.store.diagramDraft(first.id)).toEqual(draft);
  await f.lifecycle.emptyTrash(confirmation);
  expect(await f.client.get("first")).toMatchObject({ name: "first" });
  await f.server.store.trashTab(first.id, entry.trashedAt! + 1000);
  await f.lifecycle.emptyTrash(confirmation);
  expect(await f.client.get("first")).toMatchObject({ name: "first" });
  await f.lifecycle.emptyTrash([{ id: first.id, trashedAt: entry.trashedAt! + 1000 }]);
  await expect(f.client.get("first")).rejects.toMatchObject({ status: 404 });
  await f.lifecycle.closeTab(second.id);
  const now = Date.now();
  await f.server.store.restoreTab(second.id, now);
  await f.lifecycle.checkRetention([], now + DAY - 1);
  expect((await f.lifecycle.workspace()).tabs).toHaveLength(1);
  await f.lifecycle.checkRetention([], now + DAY);
  expect((await f.lifecycle.workspace()).tabs).toEqual([]);
});

test("a long absence starts a full trash interval when cleanup runs", async () => {
  const f = await fixture();
  const tab = await f.publish("away");
  const now = Date.now();
  await f.server.store.markTabsVisible([tab.id], now);
  await f.lifecycle.checkRetention([], now + 30 * DAY);
  expect((await f.server.store.retainedTabs())[0].trashedAt).toBe(now + 30 * DAY);
  expect(await f.client.get("away")).toBeDefined();
});

test("schema 4 upgrades preserve names, tab IDs, order, and drafts with a fresh temporary allowance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-retention-import-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let store = await ArtifactStore.open(directory);
  const id = await store.reserve("named", 0);
  const blob = await store.upload(
    id,
    (async function* () {
      yield Buffer.from("Retain me");
    })(),
  );
  await store.put("named", {
    tabId: id,
    blob,
    title: "Named",
    name: "release-review",
    kind: "text",
    mediaType: "text/plain",
    fileName: "note.txt",
    expectedRevision: 0,
  });
  const tab = await store.openTab({
    id,
    groupId: crypto.randomUUID(),
    type: "file",
    title: "Named",
    state: { version: 1, data: { artifactId: "named" } },
  });
  await store.saveDiagramDraft(id, draft);
  await store.close();
  const db = new DatabaseSync(join(directory, "scope.db"));
  db.exec(
    "DROP TABLE publications; DROP TABLE plan_drafts; DROP TABLE plan_receipts; DROP TABLE plan_records; DROP TABLE plan_images; DROP TABLE plan_revisions; DROP TABLE plan_state; DROP TABLE pull_requests_pr_state; DROP TABLE pull_requests_receipts; DROP TABLE pull_requests_current; DROP TABLE pull_requests_state; ALTER TABLE live_tabs DROP COLUMN permanent; ALTER TABLE live_tabs DROP COLUMN last_visible_at; ALTER TABLE live_tabs DROP COLUMN trashed_at; PRAGMA user_version = 4;",
  );
  db.close();
  const before = Date.now();
  store = await ArtifactStore.open(directory);
  cleanup.push(() => store.close());
  expect(await store.named("release-review")).toMatchObject({ id: "named" });
  expect((await store.retainedTabs())[0]).toMatchObject({ tab, permanent: false, trashedAt: null });
  expect((await store.retainedTabs())[0].lastVisibleAt).toBeGreaterThanOrEqual(before);
  expect(await store.diagramDraft(id)).toEqual(draft);
});

test("built-in tabs stay permanent, reopen once with saved state, and reject retention and type changes", async () => {
  const f = await fixture();
  const workspace = await f.lifecycle.workspace();
  const first = (await f.lifecycle.openTab({
    id: crypto.randomUUID(),
    groupId: workspace.groups[0].id,
    type: "memory",
    title: "Personal memory",
    state: { version: 1, data: {} },
  }))!;
  await f.lifecycle.saveWorkspace({
    ...workspace,
    tabs: [{ ...first, hidden: true, state: { version: 1, data: { path: "workflow/index.md" } } }],
    selected: null,
  });
  expect((await f.lifecycle.workspace()).selected).toBeNull();
  expect((await f.lifecycle.workspace()).tabs[0].hidden).toBe(true);
  await expect(f.lifecycle.setTabPermanent(first.id, false)).rejects.toThrow("always permanent");
  await expect(f.lifecycle.closeTab(first.id)).rejects.toThrow("cannot move to Trashcan");
  const rewritten = { ...first, type: "unavailable-plugin" };
  await expect(f.lifecycle.openTab(rewritten)).rejects.toThrow(
    "type of a built-in tab cannot change",
  );
  await expect(
    f.lifecycle.saveWorkspace({ ...workspace, tabs: [rewritten], selected: null }),
  ).rejects.toThrow("type of a built-in tab cannot change");
  const reopened = await Promise.all(
    Array.from({ length: 3 }, () => f.lifecycle.openTab({ ...first, id: crypto.randomUUID() })),
  );
  expect(reopened.every((tab) => tab?.id === first.id)).toBe(true);
  expect(reopened[0]).toMatchObject({
    hidden: false,
    state: { version: 1, data: { path: "workflow/index.md" } },
  });
  await f.lifecycle.checkRetention([], Date.now() + 30 * DAY);
  expect((await f.lifecycle.workspace()).tabs).toHaveLength(1);
  expect((await f.server.store.retainedTabs())[0]).toMatchObject({
    permanent: true,
    trashedAt: null,
  });
  const db = new DatabaseSync(f.server.store.filename);
  const now = Date.now();
  try {
    db.prepare("UPDATE live_tabs SET permanent = 0, last_visible_at = 0 WHERE id = ?").run(
      first.id,
    );
    expect(await f.server.store.expireTemporaryTabs(now + DAY)).toEqual([]);
    db.prepare("UPDATE live_tabs SET trashed_at = ? WHERE id = ?").run(now, first.id);
    await f.lifecycle.emptyTrash([{ id: first.id, trashedAt: now }]);
    expect((await f.server.store.retainedTabs())[0].tab.id).toBe(first.id);
  } finally {
    db.close();
  }
});
