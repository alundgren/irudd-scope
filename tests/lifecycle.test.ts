import { ArtifactLibrary } from "../apps/desktop/src/library/library.ts";
import { afterEach, beforeAll, afterAll, expect, test } from "vite-plus/test";
import { build } from "vite-plus";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactStore, UPLOAD_GRACE_MS } from "../apps/desktop/src/library/store.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import type { DiagramDraft } from "../apps/desktop/src/plugins/diagram/draft.ts";

const token = "synthetic-lifecycle-publishing-token";
const metadata = {
  title: "Review",
  kind: "text",
  mediaType: "text/plain",
  fileName: "review.txt",
  expectedRevision: 0,
};
const draft: DiagramDraft = {
  version: 1,
  content: '{"type":"excalidraw","elements":[],"files":{}}',
  revision: 1,
  dirty: true,
  messages: [],
  intent: "Unsent work",
  chatOpen: true,
  viewport: { zoom: 1, scrollX: 0, scrollY: 0 },
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(checkpoint: (point: string) => Promise<void> = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "scope-lifecycle-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const desktop = new DesktopStore(directory);
  await desktop.load();
  cleanup.push(() => desktop.close());
  let lifecycle: DesktopLifecycle;
  const server = await startArtifactServer({
    directory: join(directory, "artifacts"),
    token,
    port: 0,
    initialize: async (store) => {
      lifecycle = new DesktopLifecycle(store, desktop, checkpoint);
      await lifecycle.recover();
    },
    deleteArtifact: (id) => lifecycle.deleteArtifact(id),
    shrink: (timeoutMs) => lifecycle.shrink(timeoutMs),
  });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, token);
  const request = (path: string, method: string, body?: string | Buffer) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body:
        typeof body === "string" || body === undefined ? body : new Blob([new Uint8Array(body)]),
    });
  return { directory, server, client, lifecycle: lifecycle!, desktop, request };
}

function inspect(directory: string, check: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(directory, "artifacts/scope.db"));
  try {
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM blobs WHERE id NOT IN (SELECT blob_id FROM tab_blobs)")
        .get()?.n,
    ).toBe(0);
    for (const table of ["tab_blobs", "tab_drafts", "artifacts"])
      expect(
        db
          .prepare(
            `SELECT count(*) AS n FROM ${table} WHERE tab_id NOT IN (SELECT id FROM live_tabs)`,
          )
          .get()?.n,
      ).toBe(0);
    check(db);
  } finally {
    db.close();
  }
}

const chunks = async function* (content: string) {
  yield Buffer.from(content);
};

test("publication persists a tab first, rejects missing owners, and deletes shared content only after its last tab", async () => {
  const f = await fixture();
  expect(
    (
      await f.request(
        "/v1/artifacts/no-tab",
        "PUT",
        JSON.stringify({ ...metadata, blob: "a".repeat(64) }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.request(`/v1/tabs/${crypto.randomUUID()}/blobs`, "POST", Buffer.from("No owner")))
      .status,
  ).toBe(404);
  const { tabId } = await (
    await f.request("/v1/artifacts/first/tab", "POST", JSON.stringify({ expectedRevision: 0 }))
  ).json();
  inspect(f.directory, (db) => {
    expect(db.prepare("SELECT count(*) AS n FROM live_tabs").get()?.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM artifacts").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(0);
    db.exec("PRAGMA foreign_keys = ON");
    expect(() =>
      db
        .prepare("INSERT INTO tab_drafts VALUES (?, ?)")
        .run(crypto.randomUUID(), JSON.stringify(draft)),
    ).toThrow();
  });
  const { blob } = await (
    await f.request(`/v1/tabs/${tabId}/blobs`, "POST", Buffer.from("Shared content"))
  ).json();
  const first = await (
    await f.request("/v1/artifacts/first", "PUT", JSON.stringify({ ...metadata, tabId, blob }))
  ).json();
  await f.client.publish("second", metadata, Buffer.from("Shared content"));
  await f.server.store.saveDiagramDraft(tabId, draft);
  inspect(f.directory, (db) => {
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(1);
  });
  expect(await f.client.delete("first")).toEqual({ id: "first", deleted: true });
  expect(await f.server.store.diagramDraft(tabId)).toBeNull();
  await f.server.store.saveDiagramDraft(tabId, draft);
  expect(await f.client.delete("first")).toEqual({ id: "first", deleted: false });
  expect(Buffer.from(await f.client.content("second")).toString()).toBe("Shared content");
  const recreated = await f.client.publish("first", metadata, Buffer.from("New content"));
  expect(recreated.revision).toBeGreaterThan(first.revision);
  expect(
    (
      await f.request(
        "/v1/artifacts/first",
        "PUT",
        JSON.stringify({ ...metadata, expectedRevision: first.revision, tabId, blob }),
      )
    ).status,
  ).toBe(409);
  await expect(
    f.client.publish(
      "first",
      { ...metadata, expectedRevision: first.revision },
      Buffer.from("Stale update"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await f.client.delete("first");
  await f.client.delete("second");
  inspect(f.directory, (db) => {
    for (const table of ["live_tabs", "artifacts", "tab_drafts", "tab_blobs", "blobs"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
  });
});

test("uploads stay attached to queued tabs through deletion of another reference and expire without orphaned rows", async () => {
  const f = await fixture();
  const store = f.server.store;
  await f.client.publish("survivor", metadata, Buffer.from("Shared staging"));
  const tabId = await store.reserve("waiting", 0);
  const blob = await store.upload(tabId, chunks("Shared staging"));
  await f.client.delete("survivor");
  let expires = 0;
  inspect(f.directory, (db) => {
    expires = Number(
      db.prepare("SELECT staged_until FROM tab_blobs WHERE tab_id = ?").get(tabId)?.staged_until,
    );
  });
  expect(await store.reclaim(expires - 1)).toBe(Buffer.byteLength("Shared staging"));
  await store.put("waiting", { ...metadata, tabId, blob });
  await store.reclaim(expires + 1);
  expect(Buffer.from(await f.client.content("waiting")).toString()).toBe("Shared staging");
  const abandoned = await store.reserve("abandoned", 0);
  await store.upload(abandoned, chunks("Unused content"));
  expect((await f.client.shrink()).databases[0].deferredBytes).toBeGreaterThan(0);
  await store.reclaim(Date.now() + UPLOAD_GRACE_MS + 1);
  inspect(f.directory, (db) => {
    expect(db.prepare("SELECT id FROM live_tabs WHERE id = ?").get(abandoned)).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(1);
  });
  const old = await f.client.get("waiting");
  await f.client.publish(
    "waiting",
    { ...metadata, expectedRevision: old.revision },
    Buffer.from("New revision"),
  );
  await store.reclaim(Date.now() + UPLOAD_GRACE_MS + 1);
  inspect(f.directory, (db) => {
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(1);
  });
});

test("closing during an upload and racing an update never restores the old tab", async () => {
  const f = await fixture();
  const first = await f.client.publish("race", metadata, Buffer.from("Before"));
  const owner = (await f.server.store.tabs())[0].id;
  let release!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((done) => {
    started = done;
  });
  const finish = new Promise<void>((done) => {
    release = done;
  });
  const upload = f.server.store.upload(
    owner,
    (async function* () {
      started();
      await finish;
      yield Buffer.from("Late content");
    })(),
  );
  await reading;
  await f.client.delete("race");
  release();
  await expect(upload).rejects.toMatchObject({ status: 404 });
  await expect(
    f.client.publish(
      "race",
      { ...metadata, expectedRevision: first.revision },
      Buffer.from("Late metadata"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.client.list()).toEqual([]);
  inspect(f.directory, (db) => {
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(0);
  });
});

test("deletion events precede recreation even when close completion is delayed", async () => {
  let committed!: () => void;
  let release!: () => void;
  const closeCommitted = new Promise<void>((done) => {
    committed = done;
  });
  const finishClose = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture(async (point) => {
    if (point !== "after-close-commit") return;
    committed();
    await finishClose;
  });
  const first = await f.client.publish("event-order", metadata, Buffer.from("Before close"));
  const library = new ArtifactLibrary(f.client, () => {});
  const connection = library.connect();
  try {
    await expect.poll(() => library.snapshot().artifacts.length).toBe(1);
    const deleting = f.client.delete("event-order");
    await closeCommitted;
    const next = await f.client.publish(
      "event-order",
      metadata,
      Buffer.from("Explicit recreation"),
    );
    expect(next.revision).toBeGreaterThan(first.revision);
    await expect.poll(() => library.snapshot().artifacts[0]?.revision).toBe(next.revision);
    release();
    await deleting;
    expect(library.snapshot().artifacts).toEqual([next]);
  } finally {
    release();
    library.close();
    await connection;
  }
});

let processDirectory: string;
beforeAll(async () => {
  processDirectory = await mkdtemp(join(tmpdir(), "scope-process-build-"));
  await build({
    configFile: false,
    logLevel: "silent",
    ssr: { noExternal: true, external: ["@napi-rs/keyring"] },
    build: {
      ssr: resolve("tests/lifecycle-process.ts"),
      outDir: processDirectory,
      rolldownOptions: { output: { entryFileNames: "lifecycle-process.mjs" } },
    },
  });
});
afterAll(async () => {
  await rm(processDirectory, { recursive: true, force: true });
});

async function killAt(directory: string, point: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [join(processDirectory, "lifecycle-process.mjs"), directory, point],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Child did not reach ${point}: ${stderr}`)),
        10_000,
      );
      child.once("message", () => {
        clearTimeout(timer);
        done();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Child exited early: ${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await stopped;
    }
  }
}

test.for([
  "before-close-commit",
  "inside-close-transaction",
  "after-close-commit",
  "after-cleanup",
])(
  "a real process death at %s preserves either the whole tab or its complete deletion",
  async (point) => {
    const directory = await mkdtemp(join(tmpdir(), "scope-crash-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    let artifacts = await ArtifactStore.open(join(directory, "artifacts"));
    const desktop = new DesktopStore(directory);
    await desktop.load();
    await desktop.saveSettings({ appearance: "dark" });
    let lifecycle = new DesktopLifecycle(artifacts, desktop);
    await lifecycle.recover();
    const tabId = await artifacts.reserve("crash-test", 0);
    const blob = await artifacts.upload(tabId, chunks("Keep this until close commits"));
    await artifacts.put("crash-test", { ...metadata, tabId, blob });
    const workspace = await lifecycle.workspace();
    const tab = await lifecycle.openTab({
      id: tabId,
      groupId: workspace.groups[0].id,
      type: "file",
      title: "Crash test",
      state: { version: 1, data: { artifactId: "crash-test" } },
    });
    await lifecycle.saveWorkspace({ ...workspace, tabs: [tab], selected: tabId });
    await artifacts.saveDiagramDraft(tabId, draft);
    await artifacts.close();
    await desktop.close();
    await killAt(directory, point);
    artifacts = await ArtifactStore.open(join(directory, "artifacts"));
    const restored = new DesktopStore(directory);
    await restored.load();
    try {
      lifecycle = new DesktopLifecycle(artifacts, restored);
      await lifecycle.recover();
      await lifecycle.recover();
      const committed = point === "after-close-commit" || point === "after-cleanup";
      expect((await lifecycle.workspace()).tabs.length).toBe(committed ? 0 : 1);
      expect((await artifacts.list()).items.length).toBe(committed ? 0 : 1);
      await artifacts.saveDiagramDraft(tabId, draft);
      expect(await artifacts.diagramDraft(tabId)).toEqual(committed ? null : draft);
      expect(restored.settings().appearance).toBe("dark");
      inspect(directory, (db) => {
        expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(committed ? 0 : 1);
      });
    } finally {
      await artifacts.close();
      await restored.close();
    }
  },
);

test("a real process death during legacy import does not duplicate tabs or restore deleted drafts on retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-import-crash-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "artifacts"));
  const bytes = Buffer.from("Legacy shared bytes");
  const blob = createHash("sha256").update(bytes).digest("hex");
  const oldArtifacts = new DatabaseSync(join(directory, "artifacts/scope.db"));
  try {
    oldArtifacts.exec(
      "CREATE TABLE blobs(id TEXT PRIMARY KEY, content BLOB NOT NULL) STRICT; CREATE TABLE artifacts(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL) STRICT; PRAGMA user_version = 2;",
    );
    oldArtifacts.prepare("INSERT INTO blobs VALUES (?, ?)").run(blob, bytes);
    for (const id of ["open", "closed", "overflow"])
      oldArtifacts.prepare("INSERT INTO artifacts VALUES (?, 1, ?)").run(
        id,
        JSON.stringify({
          ...metadata,
          expectedRevision: undefined,
          id,
          revision: 1,
          blob,
          size: bytes.length,
          createdAt: "2026-09-20T08:00:00.000Z",
          updatedAt: "2026-09-20T08:00:00.000Z",
        }),
      );
  } finally {
    oldArtifacts.close();
  }
  const oldDesktop = new DatabaseSync(join(directory, "desktop.db"));
  try {
    oldDesktop.exec(
      "CREATE TABLE preferences(name TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; CREATE TABLE diagram_drafts(artifact_id TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; PRAGMA user_version = 5;",
    );
    oldDesktop
      .prepare("INSERT INTO preferences VALUES ('workspace', ?)")
      .run(JSON.stringify({ tabs: ["open"], selected: "open", closed: ["closed"] }));
    for (const id of ["open", "closed", "overflow"])
      oldDesktop.prepare("INSERT INTO diagram_drafts VALUES (?, ?)").run(id, JSON.stringify(draft));
  } finally {
    oldDesktop.close();
  }
  await killAt(directory, "after-tab-import");
  // The same import boundary can be interrupted again without allocating new IDs.
  let ids: string[] = [];
  inspect(directory, (db) => {
    ids = db
      .prepare("SELECT id FROM live_tabs ORDER BY id")
      .all()
      .map((row) => String(row.id));
  });
  await killAt(directory, "after-tab-import");
  inspect(directory, (db) => {
    expect(
      db
        .prepare("SELECT id FROM live_tabs ORDER BY id")
        .all()
        .map((row) => String(row.id)),
    ).toEqual(ids);
  });
  const artifacts = await ArtifactStore.open(join(directory, "artifacts"));
  cleanup.push(() => artifacts.close());
  const desktop = new DesktopStore(directory);
  await desktop.load();
  cleanup.push(() => desktop.close());
  const lifecycle = new DesktopLifecycle(artifacts, desktop);
  await lifecycle.recover();
  await lifecycle.recover();
  const workspace = await lifecycle.workspace();
  expect(workspace.tabs.map((tab) => tab.state.data.artifactId)).toEqual(["open"]);
  expect(workspace.selected).toBe(workspace.tabs[0].id);
  expect(await artifacts.diagramDraft(workspace.tabs[0].id)).toEqual(draft);
  expect((await artifacts.list()).items.map((item) => item.id)).toEqual(["open", "overflow"]);
  expect(await desktop.legacyWorkspace()).toBeNull();
  expect(await desktop.legacyDrafts()).toEqual([]);
  inspect(directory, (db) => {
    expect(db.prepare("SELECT count(*) AS n FROM tab_drafts").get()?.n).toBe(2);
  });
});

test("library refresh and content responses cannot restore a deleted artifact, including after reconnect", async () => {
  const f = await fixture();
  const first = await f.client.publish("list-race", metadata, Buffer.from("Before deletion"));
  const client = new ScopeClient(f.server.url, token);
  let releaseList!: () => void;
  let listed!: () => void;
  const listStarted = new Promise<void>((done) => {
    listed = done;
  });
  const listGate = new Promise<void>((done) => {
    releaseList = done;
  });
  const list = client.list.bind(client);
  let hold = true;
  client.list = async (signal) => {
    const result = await list(signal);
    if (hold) {
      hold = false;
      listed();
      await listGate;
    }
    return result;
  };
  let deleted = false;
  const watch = client.watch.bind(client);
  client.watch = (receive, signal) =>
    watch((event) => {
      if (event.type === "deleted") deleted = true;
      receive(event);
    }, signal);
  const library = new ArtifactLibrary(client, () => {});
  const connections = [library.connect()];
  try {
    await listStarted;
    await f.client.delete("list-race");
    await expect.poll(() => deleted).toBe(true);
    releaseList();
    await expect.poll(() => library.snapshot().connection).toBe("connected");
    expect(library.snapshot().artifacts).toEqual([]);
    const next = await f.client.publish("list-race", metadata, Buffer.from("New lifetime"));
    expect(next.revision).toBeGreaterThan(first.revision);
    await expect.poll(() => library.snapshot().artifacts.length).toBe(1);
    let releaseContent!: () => void;
    let contentStarted!: () => void;
    const contentReady = new Promise<void>((done) => {
      contentStarted = done;
    });
    const contentGate = new Promise<void>((done) => {
      releaseContent = done;
    });
    const content = client.content.bind(client);
    client.content = async (id, revision, signal) => {
      const result = await content(id, revision, signal);
      contentStarted();
      await contentGate;
      return result;
    };
    const loading = library.content(next.id, next.revision);
    await contentReady;
    deleted = false;
    await f.client.delete(next.id);
    await expect.poll(() => deleted).toBe(true);
    releaseContent();
    await expect(loading).rejects.toThrow();
    await expect(library.content(next.id, next.revision)).rejects.toMatchObject({ status: 404 });
    await f.client.publish("missed-delete", metadata, Buffer.from("Disconnected"));
    await expect.poll(() => library.snapshot().artifacts.length).toBe(1);
    library.close();
    await connections[0];
    await f.client.delete("missed-delete");
    connections.push(library.connect());
    await expect.poll(() => library.snapshot().connection).toBe("connected");
    expect(library.snapshot().artifacts).toEqual([]);
  } finally {
    releaseList();
    library.close();
    await Promise.all(connections);
  }
});
