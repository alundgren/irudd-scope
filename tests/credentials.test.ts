import { expect, test, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keychainCredentials } from "../apps/desktop/src/credentials.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { randomBytes, randomUUID } from "node:crypto";

function keychainEntry(initial: string | null | undefined) {
  let value = initial;
  return {
    getPassword: async () => value,
    setPassword: async (next: string) => {
      value = next;
    },
    deleteCredential: async () => {
      const existed = value != null;
      value = null;
      return existed;
    },
  };
}

test.for([null, undefined])(
  "a missing native Keychain entry is empty, not an access error: %s",
  { tags: ["secrets-stay-secret"] },
  async (missing) => {
    const entry = keychainEntry(missing);
    const credentials = keychainCredentials(entry);
    expect(await credentials.read()).toEqual({});
    await credentials.write({ apiKey: "synthetic-key" });
    expect(await credentials.read()).toEqual({ apiKey: "synthetic-key" });
    await credentials.write({});
    expect(await credentials.read()).toEqual({});
  },
);

test(
  "native access errors remain errors and retain their cause",
  { tags: ["secrets-stay-secret"] },
  async () => {
    const cause = new Error("Synthetic macOS authorization failure");
    const credentials = keychainCredentials({
      getPassword: async () => {
        throw cause;
      },
      setPassword: async () => {
        throw cause;
      },
      deleteCredential: async () => {
        throw cause;
      },
    });
    await expect(credentials.read()).rejects.toMatchObject({
      message: "Could not read Scope credentials from macOS Keychain.",
      cause,
    });
    await expect(credentials.write({ apiKey: "synthetic-key" })).rejects.toMatchObject({ cause });
    await expect(credentials.write({})).rejects.toMatchObject({ cause });
  },
);

test(
  "Keychain retains remote credentials across restarts and key changes, and drops retired pairing secrets",
  { tags: ["secrets-stay-secret", "survives-restart"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-remote-credentials-"));
    const id = "11111111-1111-4111-8111-111111111111";
    const token = "synthetic-remote-connection-token-for-tests";
    const guestKey = randomBytes(32).toString("base64url");
    const saved = JSON.stringify({
      guestPairs: {
        [randomUUID()]: {
          key: guestKey,
          endpoint: { address: "100.64.0.2", port: 41234 },
          confirmed: true,
        },
      },
      apiKey: "synthetic-existing-provider-key",
      remoteTokens: { [id]: token },
      transferKeys: { retired: 42 },
      guestKey: "synthetic-retired-guest-key",
      guestEndpoints: { retired: { address: "tc" + "z".repeat(80), port: 41234 } },
    });
    const entry = keychainEntry(saved);
    const first = new DesktopStore(directory, keychainCredentials(entry));
    const second = new DesktopStore(directory, keychainCredentials(entry));
    try {
      await first.load();
      expect(await first.secret("apiKey")).toBe("synthetic-existing-provider-key");
      expect(await first.remoteToken(id)).toBe(token);
      expect(await entry.getPassword()).toBe(saved);
      await first.saveRemote(
        { id, name: "Test remote", endpoint: "https://remote.example.test", enabled: true },
        token,
      );
      await first.saveSettings({ voiceGenerationEnabled: true, apiKey: "synthetic-provider-key" });
      expect(await entry.getPassword()).not.toContain("transferKeys");
      expect(await entry.getPassword()).not.toContain("guestKey");
      expect(await entry.getPassword()).not.toContain("guestPairs");
      expect(await entry.getPassword()).not.toContain(guestKey);
      expect(await entry.getPassword()).not.toContain("retired");
      await first.close();
      await second.load();
      expect(await second.remoteToken(id)).toBe(token);
      expect(await second.remotes()).toEqual([
        { id, name: "Test remote", endpoint: "https://remote.example.test", enabled: true },
      ]);
      await second.saveSettings({ removeApiKey: true });
      expect(await second.remoteToken(id)).toBe(token);
      await second.removeRemote(id);
      expect(await second.remoteToken(id)).toBeUndefined();
      expect(await second.secret("apiKey")).toBeUndefined();
    } finally {
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.for(['{"apiKey":"synthetic-key"', '{"apiKey":42}', "null"])(
  "invalid stored credentials do not claim Keychain is locked or reveal the value: %s",
  { tags: ["secrets-stay-secret"] },
  async (value) => {
    const credentials = keychainCredentials(keychainEntry(value));
    const error = await credentials.read().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "Scope's saved Keychain entry has an invalid format.");
    expect(error).not.toHaveProperty("cause");
    for (const invalid of [{ apiKey: 42 }, { remoteTokens: { hub: 42 } }, { hubToken: 42 }]) {
      const retained = keychainCredentials(
        keychainEntry(JSON.stringify({ guestKey: "retired", guestEndpoints: null, ...invalid })),
      );
      await expect(retained.read()).rejects.toThrow("invalid format");
    }
  },
);

test(
  "shared credentials are lazy and independent of both generation switches across restart",
  { tags: ["secrets-stay-secret", "survives-restart"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-lazy-credentials-"));
    const entry = keychainEntry(JSON.stringify({ apiKey: "existing-synthetic-key" }));
    const read = vi.spyOn(entry, "getPassword");
    let store = new DesktopStore(directory, keychainCredentials(entry));
    try {
      await store.load();
      expect(store.settings()).toMatchObject({ voiceGenerationEnabled: false, hasApiKey: null });
      await store.saveSettings({ appearance: "dark" });
      await store.saveSettings({ voiceGenerationEnabled: true });
      expect(read).not.toHaveBeenCalled();
      expect(await store.providerSettings()).toMatchObject({ hasApiKey: true });
      expect(await store.secret("apiKey")).toBe("existing-synthetic-key");
      await store.saveSettings({ voiceGenerationEnabled: false });
      expect(await store.secret("apiKey")).toBe("existing-synthetic-key");
      expect(await store.providerSettings()).toMatchObject({ hasApiKey: true });
      await store.saveSettings({ apiKey: "replacement" });
      await store.close();
      store = new DesktopStore(directory, keychainCredentials(entry));
      await store.load();
      expect(store.settings()).toMatchObject({ voiceGenerationEnabled: false, hasApiKey: null });
      expect(await store.secret("apiKey")).toBe("replacement");
      await store.saveSettings({ removeApiKey: true });
      expect(await store.secret("apiKey")).toBeUndefined();
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
