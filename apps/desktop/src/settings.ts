import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { decode, validateEndpoint } from "@irudd-scope/protocol";

export const MODEL = "google/gemini-3.8-flash";
export const ProviderSettings = Schema.Struct({
  provider: Schema.Literal("openrouter"),
  model: Schema.Literal(MODEL),
});
export const SettingsUpdate = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  hubToken: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(24), Schema.isMaxLength(2048)),
  ),
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  removeApiKey: Schema.optionalKey(Schema.Boolean),
  provider: Schema.optionalKey(Schema.Literal("openrouter")),
  model: Schema.optionalKey(Schema.Literal(MODEL)),
});
export type SettingsUpdate = typeof SettingsUpdate.Type;
export function decodeSettingsUpdate(value: unknown): SettingsUpdate {
  try {
    return decode(SettingsUpdate, value);
  } catch {
    throw new Error("Invalid settings. Check the address and key fields.");
  }
}
export type SettingsView = {
  endpoint: string;
  provider: "openrouter";
  model: typeof MODEL;
  hasHubToken: boolean;
  hasApiKey: boolean;
  keyStorage: "keychain" | "session";
};
type SecretName = "hubToken" | "apiKey";
export type SecretProtection = {
  encrypt: (text: string) => Promise<Buffer>;
  decrypt: (bytes: Buffer) => Promise<string>;
};
const SavedSettings = Schema.Struct({
  version: Schema.Literal(1),
  endpoint: Schema.String,
  provider: Schema.Literal("openrouter"),
  model: Schema.Literal(MODEL),
  hubToken: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
});

export class SettingsStore {
  private saved: typeof SavedSettings.Type = {
    version: 1,
    endpoint: "http://127.0.0.1:43120",
    provider: "openrouter",
    model: MODEL,
  };
  private readonly memory: Partial<Record<SecretName, string>> = {};
  private readonly directory: string;
  private readonly protection?: SecretProtection;
  private pending = Promise.resolve();

  constructor(directory: string, protection?: SecretProtection) {
    this.directory = directory;
    this.protection = protection;
  }

  async load(initial: { endpoint?: string; hubToken?: string } = {}): Promise<void> {
    try {
      this.saved = decode(
        SavedSettings,
        JSON.parse(await readFile(join(this.directory, "settings.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new Error("Cannot read Scope settings. Restore or remove the local settings file.");
    }
    if (initial.endpoint)
      this.saved = { ...this.saved, endpoint: validateEndpoint(initial.endpoint) };
    if (initial.hubToken) this.memory.hubToken = initial.hubToken;
  }

  view(): SettingsView {
    return {
      endpoint: this.saved.endpoint,
      provider: this.saved.provider,
      model: this.saved.model,
      hasHubToken: Boolean(this.memory.hubToken || this.saved.hubToken),
      hasApiKey: Boolean(this.memory.apiKey || this.saved.apiKey),
      keyStorage: this.protection ? "keychain" : "session",
    };
  }

  async secret(name: SecretName): Promise<string | undefined> {
    if (this.memory[name]) return this.memory[name];
    const ciphertext = this.saved[name];
    if (!ciphertext) return undefined;
    if (!this.protection)
      throw new Error(
        "This saved key requires macOS Keychain. Enter a temporary key for this session.",
      );
    try {
      return await this.protection.decrypt(Buffer.from(ciphertext, "base64"));
    } catch {
      throw new Error(
        "Cannot unlock the saved key. Allow Scope to access Keychain, or replace the key in Settings.",
      );
    }
  }

  update(value: SettingsUpdate): Promise<SettingsView> {
    const task = this.pending.then(async () => {
      const input = decodeSettingsUpdate(value);
      let next = { ...this.saved };
      const nextMemory = { ...this.memory };
      if (input.endpoint !== undefined) next.endpoint = validateEndpoint(input.endpoint);
      if (input.removeApiKey && input.apiKey)
        throw new Error("Choose either replacing or removing the key.");
      if (input.removeApiKey) {
        delete next.apiKey;
        delete nextMemory.apiKey;
      }
      for (const name of ["hubToken", "apiKey"] as const) {
        const secret = input[name]?.trim();
        if (secret !== undefined) {
          if (!secret || /[\r\n]/.test(secret)) throw new Error("Enter a key on one line.");
          if (this.protection) {
            try {
              next[name] = (await this.protection.encrypt(secret)).toString("base64");
            } catch {
              throw new Error(
                "Cannot save the key in secure storage. Allow Scope to access Keychain and try again.",
              );
            }
            delete nextMemory[name];
          } else {
            nextMemory[name] = secret;
            delete next[name];
          }
        }
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, "settings.tmp");
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, join(this.directory, "settings.json"));
      this.saved = next;
      delete this.memory.apiKey;
      delete this.memory.hubToken;
      Object.assign(this.memory, nextMemory);
      return this.view();
    });
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
