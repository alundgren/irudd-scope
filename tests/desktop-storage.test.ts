import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { importWorkspace } from "../apps/desktop/src/workspace/contract.ts";
import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DIAGRAM_MODEL } from "../apps/desktop/src/plugins/diagram/provider-settings.ts";
import type { DiagramDraft } from "../apps/desktop/src/plugins/diagram/draft.ts";
import {
  memoryCredentials,
  type CredentialStore,
  type Secrets,
} from "../apps/desktop/src/credentials.ts";

function fakeKeychain(): CredentialStore {
  return { ...memoryCredentials(), kind: "keychain" };
}
function documents(directory: string): string {
  const db = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try {
    return JSON.stringify(db.prepare("SELECT * FROM preferences").all());
  } finally {
    db.close();
  }
}

test("tab-owned drafts and plugin state survive restart, then close deletes them and ignores late saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-drafts-"));
  const store = new DesktopStore(directory);
  let artifacts = await ArtifactStore.open(join(directory, "artifacts"));
  const draft: DiagramDraft = {
    version: 1,
    content: JSON.stringify({ type: "excalidraw", elements: [], files: {} }),
    revision: 1,
    dirty: true,
    messages: [{ role: "user", text: "Move the API" }],
    intent: "Unsent prompt",
    chatOpen: true,
    viewport: { zoom: 0.75, scrollX: 120, scrollY: -50 },
  };
  try {
    await store.load();
    let lifecycle = new DesktopLifecycle(artifacts, store);
    await lifecycle.recover();
    const workspace = await lifecycle.workspace();
    const tab = await lifecycle.openTab({
      id: crypto.randomUUID(),
      groupId: workspace.groups[0].id,
      type: "future-tool",
      title: "Future tool",
      state: { version: 5, data: { prompt: "Keep me" } },
    });
    await lifecycle.saveWorkspace({ ...workspace, tabs: [tab], selected: tab.id });
    await artifacts.saveDiagramDraft(tab.id, draft);
    await expect(
      artifacts.saveDiagramDraft(tab.id, { ...draft, viewport: { ...draft.viewport, zoom: -1 } }),
    ).rejects.toThrow();
    await artifacts.close();
    artifacts = await ArtifactStore.open(join(directory, "artifacts"));
    lifecycle = new DesktopLifecycle(artifacts, store);
    await lifecycle.recover();
    expect((await lifecycle.workspace()).tabs).toEqual([tab]);
    expect(await artifacts.diagramDraft(tab.id)).toEqual(draft);
    await lifecycle.closeTab(tab.id);
    await lifecycle.saveWorkspace({ ...workspace, tabs: [tab], selected: tab.id });
    await artifacts.saveDiagramDraft(tab.id, draft);
    expect((await lifecycle.workspace()).tabs).toEqual([]);
    expect(await artifacts.diagramDraft(tab.id)).toBeNull();
    const db = new DatabaseSync(join(directory, "artifacts/scope.db"));
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM tab_drafts").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await artifacts.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary settings and tabs reopen from SQLite while credentials stay exclusively in the credential store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
  const credentials = fakeKeychain();
  const store = new DesktopStore(directory, credentials);
  let reopened: DesktopStore | undefined;
  try {
    await store.load();
    const secret = "synthetic-provider-secret";
    const view = await store.saveSettings({
      apiKey: secret,
      appearance: "dark",
    });
    const workspace = importWorkspace({ tabs: ["architecture", "review"], selected: "review" });
    await store.saveLayout({ groups: workspace.groups, selected: workspace.selected });
    expect(view).toMatchObject({ hasApiKey: true, keyStorage: "keychain" });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view).not.toHaveProperty("endpoint");
    expect(view).not.toHaveProperty("hasHubToken");
    expect(documents(directory)).not.toContain(secret);
    expect(documents(directory)).not.toContain('"apiKey"');
    expect(await readdir(directory)).not.toContain("settings.json");
    await store.close();
    reopened = new DesktopStore(directory, credentials);
    await reopened.load();
    expect(reopened.settings().appearance).toBe("dark");
    expect(await reopened.layout()).toEqual({
      groups: workspace.groups,
      selected: workspace.selected,
    });
    expect(await reopened.secret("apiKey")).toBe(secret);
    await reopened.saveSettings({ apiKey: "replacement-secret" });
    expect(await reopened.secret("apiKey")).toBe("replacement-secret");
    await reopened.saveSettings({ removeApiKey: true });
    expect(await reopened.secret("apiKey")).toBeUndefined();
    expect(await credentials.read()).toEqual({});
  } finally {
    await reopened?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux development credentials disappear when the process store is recreated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
  const store = new DesktopStore(directory);
  let reopened: DesktopStore | undefined;
  try {
    await store.load();
    await store.saveSettings({
      apiKey: "temporary-secret",
    });
    expect(await store.secret("apiKey")).toBe("temporary-secret");
    expect(documents(directory)).not.toContain("temporary");
    await store.close();
    reopened = new DesktopStore(directory);
    await reopened.load();
    expect(reopened.settings()).toMatchObject({ hasApiKey: false });
  } finally {
    await reopened?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.for([1, 2] as const)(
  "version %i JSON settings migrate into SQLite and Keychain without retaining hub configuration",
  async (version) => {
    const directory = await mkdtemp(join(tmpdir(), "scope-settings-migration-"));
    const ciphertext = Buffer.from("synthetic-legacy-ciphertext").toString("base64");
    const credentials = fakeKeychain();
    const store = new DesktopStore(directory, credentials, async () => "legacy-provider-key");
    try {
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({
          version,
          ...(version === 1
            ? { endpoint: "https://old-hub.invalid", hubToken: "obsolete-encrypted-hub-token" }
            : {}),
          provider: "openrouter",
          model: DIAGRAM_MODEL,
          apiKey: ciphertext,
        }),
      );
      await store.load();
      expect(await credentials.read()).toEqual({ apiKey: "legacy-provider-key" });
      expect(documents(directory)).not.toContain(ciphertext);
      expect(documents(directory)).not.toContain("old-hub");
      expect(documents(directory)).not.toContain("hubToken");
      expect(documents(directory)).not.toContain("legacy-provider-key");
      await expect(readFile(join(directory, "settings.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a locked or failing Keychain remains visible and cannot silently remove a saved key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-keychain-failure-"));
  let locked = false;
  let secrets: Secrets = { apiKey: "existing-provider-key" };
  const credentials: CredentialStore = {
    kind: "keychain",
    read: async () => {
      if (locked) throw new Error("Keychain locked");
      return { ...secrets };
    },
    write: async (next) => {
      if (locked) throw new Error("Keychain locked");
      secrets = { ...next };
    },
  };
  const store = new DesktopStore(directory, credentials);
  try {
    await store.load();
    locked = true;
    await expect(store.saveSettings({ removeApiKey: true })).rejects.toThrow("Keychain locked");
    const view = await store.saveSettings({ provider: "openrouter" });
    expect(view.credentialError).toContain("Key status is unavailable");
    expect(view.hasApiKey).toBe(true);
    expect(secrets.apiKey).toBe("existing-provider-key");
    await expect(store.secret("apiKey")).rejects.toThrow("Keychain locked");
    locked = false;
    const retried = await store.saveSettings({});
    expect(retried.credentialError).toBeUndefined();
    expect(retried.hasApiKey).toBe(true);
    expect(await store.secret("apiKey")).toBe("existing-provider-key");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing SQLite preferences retain tabs and provider credentials while discarding obsolete hub settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-sqlite-settings-migration-"));
  const credentials = fakeKeychain();
  const workspace = { tabs: ["review"], selected: "review" };
  const db = new DatabaseSync(join(directory, "desktop.db"));
  try {
    db.exec(
      "CREATE TABLE preferences(name TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; PRAGMA user_version = 1;",
    );
    const insert = db.prepare("INSERT INTO preferences VALUES (?, ?)");
    insert.run(
      "settings",
      JSON.stringify({
        version: 1,
        provider: "openrouter",
        model: DIAGRAM_MODEL,
        endpoint: "https://old-hub.invalid",
      }),
    );
    insert.run("workspace", JSON.stringify(workspace));
  } finally {
    db.close();
  }
  const store = new DesktopStore(directory, credentials);
  try {
    await credentials.write({ apiKey: "existing-provider-key" });
    await store.load();
    const migrated = await store.legacyWorkspace();
    expect(migrated?.version).toBe(3);
    expect(migrated?.tabs.map((tab) => tab.state.data.artifactId)).toEqual(workspace.tabs);
    expect(migrated?.selected).toBe(migrated?.tabs[0].id);
    expect(store.settings().appearance).toBe("system");
    expect(await store.secret("apiKey")).toBe("existing-provider-key");
    expect(documents(directory)).not.toContain("endpoint");
    expect(store.settings()).not.toHaveProperty("hasHubToken");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed credential migration retains the JSON settings for a successful retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-migration-retry-"));
  const legacy = JSON.stringify({
    version: 2,
    provider: "openrouter",
    model: DIAGRAM_MODEL,
    apiKey: Buffer.from("synthetic-ciphertext").toString("base64"),
  });
  const credentials = fakeKeychain();
  const failed = new DesktopStore(directory, credentials, async () => {
    throw new Error("Keychain locked");
  });
  const retry = new DesktopStore(directory, credentials, async () => "recovered-provider-key");
  try {
    await writeFile(join(directory, "settings.json"), legacy);
    await expect(failed.load()).rejects.toThrow("Keychain locked");
    expect(await readFile(join(directory, "settings.json"), "utf8")).toBe(legacy);
    expect(await credentials.read()).toEqual({});
    await retry.load();
    expect(await retry.secret("apiKey")).toBe("recovered-provider-key");
    await expect(readFile(join(directory, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await failed.close();
    await retry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy open tabs migrate with stable IDs while closed-only artifacts and drafts are removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-tab-migration-"));
  const artifacts = await ArtifactStore.open(join(directory, "artifacts"));
  const metadata = {
    title: "Example",
    kind: "text",
    mediaType: "text/plain",
    fileName: "example.txt",
    expectedRevision: 0,
  };
  for (const id of ["first", "diagram", "closed", "overflow"]) {
    const tabId = await artifacts.reserve(id, 0);
    const blob = await artifacts.upload(
      tabId,
      (async function* () {
        yield Buffer.from("Shared bytes");
      })(),
    );
    await artifacts.put(id, { ...metadata, tabId, blob });
  }
  const db = new DatabaseSync(join(directory, "desktop.db"));
  db.exec(
    "CREATE TABLE preferences(name TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; CREATE TABLE diagram_drafts(artifact_id TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; PRAGMA user_version = 3;",
  );
  const oldWorkspace = importWorkspace({ tabs: ["first", "diagram"], selected: "diagram" });
  db.prepare("INSERT INTO preferences VALUES ('workspace', ?)").run(
    JSON.stringify({
      ...oldWorkspace,
      version: 2,
      closed: ["first", "closed"].map((artifactId) => ({
        ...oldWorkspace.tabs[0],
        id: crypto.randomUUID(),
        state: { version: 1, data: { artifactId } },
      })),
    }),
  );
  const legacyDraft: DiagramDraft = {
    version: 1,
    content: JSON.stringify({ type: "excalidraw", elements: [], files: {} }),
    revision: 1,
    dirty: true,
    messages: [{ role: "user", text: "Keep the conversation" }],
    intent: "Unsent draft",
    chatOpen: true,
    viewport: { zoom: 1, scrollX: 0, scrollY: 0 },
  };
  for (const id of ["diagram", "closed", "overflow"])
    db.prepare("INSERT INTO diagram_drafts VALUES (?, ?)").run(id, JSON.stringify(legacyDraft));
  db.prepare("INSERT INTO preferences VALUES ('unrelated-plugin', ?)").run(
    JSON.stringify({ keep: true }),
  );
  db.close();
  const store = new DesktopStore(directory);
  try {
    await store.load();
    const before = (await store.legacyWorkspace())!;
    const lifecycle = new DesktopLifecycle(artifacts, store);
    await lifecycle.recover();
    const workspace = await lifecycle.workspace();
    expect(workspace.tabs).toEqual(before.tabs);
    expect(workspace.selected).toBe(workspace.tabs[1].id);
    expect(workspace.groups).toEqual(before.groups);
    expect((await artifacts.list()).items.map((item) => item.id)).toEqual([
      "diagram",
      "first",
      "overflow",
    ]);
    await expect(artifacts.get("closed")).rejects.toMatchObject({ status: 404 });
    const owners = await artifacts.tabs();
    for (const artifactId of ["diagram", "overflow"])
      expect(
        await artifacts.diagramDraft(owners.find((tab) => tab.artifact_id === artifactId)!.id),
      ).toEqual(legacyDraft);
    expect(owners.some((tab) => tab.artifact_id === "closed")).toBe(false);
    expect(await store.legacyWorkspace()).toBeNull();
    await lifecycle.recover();
    expect(await lifecycle.workspace()).toEqual(workspace);
    expect(documents(directory)).toContain("unrelated-plugin");
    expect(() =>
      lifecycle.saveWorkspace({
        ...workspace,
        tabs: [{ ...workspace.tabs[0], groupId: crypto.randomUUID() }],
      }),
    ).toThrow();
    expect(() =>
      lifecycle.saveWorkspace({
        ...workspace,
        tabs: [{ ...workspace.tabs[0], state: { version: 1, data: { wrong: true } } }],
      }),
    ).toThrow();
  } finally {
    await store.close();
    await artifacts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
