import { expect, test } from "vite-plus/test";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { windowsCredentials } from "../apps/desktop/src/credentials.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";

function protection() {
  const key = randomBytes(32);
  const failures = { unavailable: false, encrypt: false, decrypt: false };
  return {
    failures,
    isAsyncEncryptionAvailable: async () => !failures.unavailable,
    encryptStringAsync: async (value: string) => {
      if (failures.encrypt) throw new Error("Synthetic encryption failure");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptStringAsync: async (value: Buffer) => {
      if (failures.decrypt) throw new Error("Synthetic decryption failure");
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return {
        result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8"),
      };
    },
  };
}

function preferences(directory: string) {
  const db = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try {
    return db.prepare("SELECT name, document FROM preferences ORDER BY name").all();
  } finally {
    db.close();
  }
}

test(
  "Windows credentials survive restart, remain encrypted, and preserve unrelated keys on removal",
  { tags: ["secrets-stay-secret", "survives-restart"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope windows credentials-"));
    const encryption = protection();
    const factory = windowsCredentials(encryption);
    let store = new DesktopStore(directory, factory);
    const providerKey = "synthetic-provider-" + "a".repeat(3000);
    const token = "synthetic-remote-token-long-enough-for-validation";
    const remote = {
      id: randomUUID(),
      name: "Remote",
      endpoint: "https://remote.example.test",
      enabled: true,
    };
    const peer = {
      id: randomUUID(),
      deviceId: randomUUID(),
      name: "Personal PC",
      createdAt: Date.now(),
    };
    const transferKey = randomBytes(32).toString("base64url");
    try {
      await store.load();
      expect(store.settings()).toMatchObject({ hasApiKey: null, keyStorage: "windows" });
      await Promise.all([
        store.saveSettings({ apiKey: providerKey }),
        store.saveRemote(remote, token),
        store.saveScopePeer(peer, transferKey),
      ]);
      await store.saveGuestEndpoint(peer.id, { address: "100.64.0.2", port: 41234 });
      const persisted = JSON.stringify(preferences(directory));
      for (const secret of [providerKey, token, transferKey, "100.64.0.2"])
        expect(persisted).not.toContain(secret);
      expect(persisted).toContain("ciphertext");
      await store.close();
      const saved = {
        apiKey: providerKey,
        remoteTokens: { [remote.id]: token },
        transferKeys: { [peer.id]: transferKey },
        guestKey: "synthetic-retired-guest-key",
        guestEndpoints: {
          [peer.id]: { address: "100.64.0.2", port: 41234 },
          retired: { address: "tc" + "z".repeat(80), port: 41234 },
          invalid: { address: "8.8.8.8", port: 41234 },
        },
      };
      const ciphertext = await encryption.encryptStringAsync(JSON.stringify(saved));
      const db = new DatabaseSync(join(directory, "desktop.db"));
      try {
        db.prepare("UPDATE preferences SET document = ? WHERE name = 'windows-credentials'").run(
          JSON.stringify({ version: 1, ciphertext: ciphertext.toString("base64") }),
        );
      } finally {
        db.close();
      }
      const beforeRead = preferences(directory).find((row) => row.name === "windows-credentials");
      store = new DesktopStore(directory, factory);
      await store.load();
      expect(store.settings().hasApiKey).toBeNull();
      expect(await store.providerSettings()).toMatchObject({
        hasApiKey: true,
        keyStorage: "windows",
      });
      expect(JSON.stringify(store.settings())).not.toContain(providerKey);
      expect(await store.secret("apiKey")).toBe(providerKey);
      expect(await store.remoteToken(remote.id)).toBe(token);
      expect(await store.transferKey(peer.id)).toBe(transferKey);
      expect(await store.guestEndpoint(peer.id)).toEqual({
        address: "100.64.0.2",
        port: 41234,
      });
      expect(await store.guestEndpoint("retired")).toBeUndefined();
      expect(await store.guestEndpoint("invalid")).toBeUndefined();
      expect(preferences(directory).find((row) => row.name === "windows-credentials")).toEqual(
        beforeRead,
      );
      await store.saveSettings({ apiKey: "synthetic-replacement-provider-key" });
      expect(await store.secret("apiKey")).toBe("synthetic-replacement-provider-key");
      const updated = preferences(directory).find((row) => row.name === "windows-credentials")!;
      const protectedValue = JSON.parse(String(updated.document));
      const plaintext = await encryption.decryptStringAsync(
        Buffer.from(protectedValue.ciphertext, "base64"),
      );
      expect(plaintext.result).not.toContain("guestKey");
      expect(plaintext.result).not.toContain("retired");
      expect(plaintext.result).not.toContain("8.8.8.8");
      await store.saveSettings({ removeApiKey: true });
      expect(await store.remoteToken(remote.id)).toBe(token);
      expect(await store.transferKey(peer.id)).toBe(transferKey);
      await store.removeRemote(remote.id);
      await store.removeScopePeer(peer.id);
      expect(await store.secret("apiKey")).toBeUndefined();
      expect(await store.guestEndpoint(peer.id)).toBeUndefined();
      expect(JSON.stringify(preferences(directory))).not.toContain("synthetic-guest-key");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows protection failures keep saved credentials and allow retry without a plaintext fallback",
  { tags: ["secrets-stay-secret"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope windows protection-"));
    const encryption = protection();
    const store = new DesktopStore(directory, windowsCredentials(encryption));
    try {
      await store.load();
      await store.saveSettings({ apiKey: "synthetic-original-key" });
      const saved = preferences(directory);
      encryption.failures.encrypt = true;
      await expect(store.saveSettings({ apiKey: "synthetic-replacement-key" })).rejects.toThrow(
        "Windows protection",
      );
      expect(preferences(directory)).toEqual(saved);
      encryption.failures.encrypt = false;
      encryption.failures.decrypt = true;
      expect(await store.providerSettings()).toHaveProperty("credentialError");
      await expect(store.saveSettings({ removeApiKey: true })).rejects.toThrow(
        "protected by Windows",
      );
      expect(preferences(directory)).toEqual(saved);
      encryption.failures.decrypt = false;
      encryption.failures.unavailable = true;
      await expect(store.secret("apiKey")).rejects.toThrow("protected by Windows");
      encryption.failures.unavailable = false;
      expect(await store.secret("apiKey")).toBe("synthetic-original-key");
      expect(await store.providerSettings()).not.toHaveProperty("credentialError");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "invalid Windows credential records remain intact and do not expose their contents in errors",
  { tags: ["secrets-stay-secret"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope windows invalid-"));
    const encryption = protection();
    const store = new DesktopStore(directory, windowsCredentials(encryption));
    try {
      await store.load();
      const db = new DatabaseSync(store.filename);
      try {
        db.prepare("INSERT INTO preferences(name, document) VALUES ('windows-credentials', ?)").run(
          JSON.stringify({ version: 1, ciphertext: "invalid synthetic secret" }),
        );
      } finally {
        db.close();
      }
      const saved = preferences(directory);
      const settings = await store.providerSettings();
      expect(settings).toHaveProperty("credentialError");
      expect(JSON.stringify(settings)).not.toContain("invalid synthetic secret");
      await expect(store.saveSettings({ apiKey: "synthetic-new-key" })).rejects.toThrow(
        "protected by Windows",
      );
      expect(preferences(directory)).toEqual(saved);
      for (const invalid of [
        { apiKey: 42 },
        { remoteTokens: { hub: 42 } },
        { transferKeys: { peer: 42 } },
      ]) {
        const ciphertext = await encryption.encryptStringAsync(
          JSON.stringify({ guestKey: "retired", guestEndpoints: null, ...invalid }),
        );
        const db = new DatabaseSync(store.filename);
        try {
          db.prepare("UPDATE preferences SET document = ? WHERE name = 'windows-credentials'").run(
            JSON.stringify({ version: 1, ciphertext: ciphertext.toString("base64") }),
          );
        } finally {
          db.close();
        }
        const before = preferences(directory);
        await expect(store.secret("apiKey")).rejects.toThrow("protected by Windows");
        await expect(store.saveSettings({ apiKey: "synthetic-new-key" })).rejects.toThrow(
          "protected by Windows",
        );
        expect(preferences(directory)).toEqual(before);
      }
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
