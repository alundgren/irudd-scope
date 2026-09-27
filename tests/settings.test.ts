import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore, MODEL } from "../apps/desktop/src/settings.ts";
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

test("ordinary settings and tabs reopen from SQLite while credentials stay exclusively in the credential store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
  const credentials = fakeKeychain();
  const settings = new SettingsStore(directory, credentials);
  let reopened: SettingsStore | undefined;
  try {
    await settings.load();
    const secret = "synthetic-provider-secret";
    const view = await settings.update({
      apiKey: secret,
      endpoint: "https://scope.example.ts.net",
    });
    await settings.saveWorkspace({ tabs: ["architecture", "review"], selected: "review" });
    expect(view).toMatchObject({ hasApiKey: true, keyStorage: "keychain" });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(documents(directory)).toContain("https://scope.example.ts.net");
    expect(documents(directory)).not.toContain(secret);
    expect(documents(directory)).not.toContain('"apiKey"');
    expect(await readdir(directory)).not.toContain("settings.json");
    await settings.close();
    reopened = new SettingsStore(directory, credentials);
    await reopened.load();
    expect(await reopened.workspace()).toEqual({
      tabs: ["architecture", "review"],
      selected: "review",
    });
    expect(await reopened.secret("apiKey")).toBe(secret);
    await reopened.update({ apiKey: "replacement-secret" });
    expect(await reopened.secret("apiKey")).toBe("replacement-secret");
    await reopened.update({ removeApiKey: true });
    expect(await reopened.secret("apiKey")).toBeUndefined();
    expect(await credentials.read()).toEqual({});
  } finally {
    await reopened?.close();
    await settings.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux development credentials disappear when the process store is recreated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
  const settings = new SettingsStore(directory);
  let reopened: SettingsStore | undefined;
  try {
    await settings.load();
    await settings.update({
      apiKey: "temporary-secret",
      hubToken: "temporary-hub-token-at-least-24",
    });
    expect(await settings.secret("apiKey")).toBe("temporary-secret");
    expect(documents(directory)).not.toContain("temporary");
    await settings.close();
    reopened = new SettingsStore(directory);
    await reopened.load();
    expect(reopened.view()).toMatchObject({ hasApiKey: false, hasHubToken: false });
  } finally {
    await reopened?.close();
    await settings.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy settings migrate into SQLite and Keychain without copying ciphertext into the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-migration-"));
  const ciphertext = Buffer.from("synthetic-legacy-ciphertext").toString("base64");
  const credentials = fakeKeychain();
  const settings = new SettingsStore(directory, credentials, async () => "legacy-provider-key");
  try {
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        version: 1,
        endpoint: "http://127.0.0.1:43120",
        provider: "openrouter",
        model: MODEL,
        apiKey: ciphertext,
      }),
    );
    await settings.load();
    expect(await credentials.read()).toEqual({ apiKey: "legacy-provider-key" });
    expect(documents(directory)).not.toContain(ciphertext);
    expect(documents(directory)).not.toContain("legacy-provider-key");
    await expect(readFile(join(directory, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await settings.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
  const settings = new SettingsStore(directory, credentials);
  try {
    await settings.load();
    locked = true;
    await expect(settings.update({ removeApiKey: true })).rejects.toThrow("Keychain locked");
    const view = await settings.update({ endpoint: "https://scope.example.ts.net" });
    expect(view.credentialError).toContain("Key status is unavailable");
    expect(view.hasApiKey).toBe(true);
    expect(secrets.apiKey).toBe("existing-provider-key");
    await expect(settings.secret("apiKey")).rejects.toThrow("Keychain locked");
  } finally {
    await settings.close();
    await rm(directory, { recursive: true, force: true });
  }
});
