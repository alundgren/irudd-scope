import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DIAGRAM_MODEL } from "../apps/desktop/src/diagram/provider-settings.ts";
import type { DiagramDraft } from "../apps/desktop/src/diagram/draft.ts";
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

test("diagram working data survives closing every tab and reopening the SQLite store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-drafts-"));
  const store = new DesktopStore(directory);
  const reopened = new DesktopStore(directory);
  const draft: DiagramDraft = {
    version: 1,
    content: JSON.stringify({ type: "excalidraw", elements: [], files: {} }),
    revision: 4,
    dirty: true,
    messages: [
      { role: "user", text: "Move the API" },
      { role: "assistant", text: "Moved it." },
    ],
    intent: "Keep this unfinished prompt",
    chatOpen: true,
    viewport: { zoom: 0.75, scrollX: 120, scrollY: -50 },
  };
  try {
    await store.load();
    expect(await store.diagramDraft("architecture")).toBeNull();
    await store.saveDiagramDraft("architecture", draft);
    await store.saveWorkspace({ tabs: [], selected: null, closed: ["architecture"] });
    expect(() =>
      store.saveDiagramDraft("architecture", {
        ...draft,
        viewport: { ...draft.viewport, zoom: -1 },
      }),
    ).toThrow();
    expect(() =>
      store.saveWorkspace({
        tabs: ["architecture"],
        selected: "architecture",
        closed: ["architecture"],
      }),
    ).toThrow();
    await store.close();
    await reopened.load();
    expect(await reopened.diagramDraft("architecture")).toEqual(draft);
    expect(await reopened.workspace()).toEqual({
      tabs: [],
      selected: null,
      closed: ["architecture"],
    });
    expect(await readdir(directory)).not.toContain("settings.json");
  } finally {
    await store.close();
    await reopened.close();
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
    await store.saveWorkspace({ tabs: ["architecture", "review"], selected: "review" });
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
    expect(await reopened.workspace()).toEqual({
      tabs: ["architecture", "review"],
      selected: "review",
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
    expect(await store.workspace()).toEqual(workspace);
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
