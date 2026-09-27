import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SettingsStore } from "../apps/desktop/src/settings.ts";

test("saved keys round-trip only through the secret protector and never appear in the settings view or file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
  const key = randomBytes(32);
  const protection = {
    encrypt: async (text: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt: async (bytes: Buffer) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    },
  };
  try {
    const settings = new SettingsStore(directory, protection);
    await settings.load();
    const secret = "synthetic-provider-secret";
    const view = await settings.update({ apiKey: secret });
    expect(view).toMatchObject({ hasApiKey: true, keyStorage: "keychain" });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(await readFile(join(directory, "settings.json"), "utf8")).not.toContain(secret);
    const saved = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        ...saved,
        version: 1,
        endpoint: "https://old-hub.invalid",
        hubToken: "legacy-encrypted-token",
      }),
    );
    const reopened = new SettingsStore(directory, protection);
    await reopened.load();
    expect(await reopened.secret("apiKey")).toBe(secret);
    expect(reopened.view()).not.toHaveProperty("endpoint");
    expect(reopened.view()).not.toHaveProperty("hasHubToken");
    await reopened.update({ apiKey: "replacement-secret" });
    expect(await reopened.secret("apiKey")).toBe("replacement-secret");
    const migrated = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    expect(migrated.version).toBe(2);
    expect(migrated).not.toHaveProperty("endpoint");
    expect(migrated).not.toHaveProperty("hubToken");
    await reopened.update({ removeApiKey: true });
    expect(await reopened.secret("apiKey")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux development credentials disappear when the process store is recreated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-settings-"));
  try {
    const settings = new SettingsStore(directory);
    await settings.load();
    await settings.update({
      apiKey: "temporary-secret",
    });
    expect(await settings.secret("apiKey")).toBe("temporary-secret");
    const saved = await readFile(join(directory, "settings.json"), "utf8");
    expect(saved).not.toContain("temporary");
    const reopened = new SettingsStore(directory);
    await reopened.load();
    expect(reopened.view()).toMatchObject({ hasApiKey: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
