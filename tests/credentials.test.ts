import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keychainCredentials } from "../apps/desktop/src/credentials.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DIAGRAM_MODEL } from "../apps/desktop/src/plugins/diagram/provider-settings.ts";

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

test("native access errors remain errors and retain their cause", async () => {
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
});

test.for(['{"apiKey":"synthetic-key"', '{"apiKey":42}', "null"])(
  "invalid stored credentials do not claim Keychain is locked or reveal the value: %s",
  async (value) => {
    const credentials = keychainCredentials(keychainEntry(value));
    const error = await credentials.read().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "Scope's saved Keychain entry has an invalid format.");
    expect(error).not.toHaveProperty("cause");
  },
);

test("legacy settings migrate when the native Keychain entry does not exist yet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-native-credential-migration-"));
  const credentials = keychainCredentials(keychainEntry(null));
  const store = new DesktopStore(directory, credentials, async () => "synthetic-migrated-key");
  try {
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        version: 2,
        provider: "openrouter",
        model: DIAGRAM_MODEL,
        apiKey: Buffer.from("synthetic-encrypted-key").toString("base64"),
      }),
    );
    await store.load();
    expect(store.settings()).toMatchObject({ hasApiKey: true, keyStorage: "keychain" });
    expect(store.settings().credentialError).toBeUndefined();
    expect(await credentials.read()).toEqual({ apiKey: "synthetic-migrated-key" });
    await expect(readFile(join(directory, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
