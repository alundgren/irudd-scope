import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ArtifactId, decode, validateEndpoint } from "@irudd-scope/protocol";
import { memoryCredentials, type CredentialStore, type Secrets } from "./credentials.ts";

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
  credentialError?: string;
};
export const Workspace = Schema.Struct({
  tabs: Schema.Array(ArtifactId).check(Schema.isMaxLength(100)),
  selected: Schema.NullOr(ArtifactId),
});
export type Workspace = typeof Workspace.Type;
const SavedSettings = Schema.Struct({
  version: Schema.Literal(1),
  endpoint: Schema.String,
  provider: Schema.Literal("openrouter"),
  model: Schema.Literal(MODEL),
});
const LegacySettings = Schema.Struct({
  ...SavedSettings.fields,
  hubToken: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
});
const databaseRuntime = (filename: string) => ManagedRuntime.make(SqliteClient.layer({ filename }));

export class SettingsStore {
  private saved: typeof SavedSettings.Type = {
    version: 1,
    endpoint: "http://127.0.0.1:43120",
    provider: "openrouter",
    model: MODEL,
  };
  private runtime?: ReturnType<typeof databaseRuntime>;
  private sql?: SqliteClient.SqliteClient;
  private readonly sessionSecrets: Partial<Record<keyof Secrets, string>> = {};
  private presence = { hasHubToken: false, hasApiKey: false };
  private credentialError?: string;
  private pending = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly credentials: CredentialStore = memoryCredentials(),
    private readonly decodeLegacySecret?: (bytes: Buffer) => Promise<string>,
  ) {}

  async load(initial: { endpoint?: string; hubToken?: string } = {}): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = join(this.directory, "desktop.db");
    this.runtime = databaseRuntime(filename);
    try {
      const sql = (this.sql = await this.runtime.runPromise(SqliteClient.SqliteClient));
      await chmod(filename, 0o600);
      const [{ user_version: version }] = await this.run(
        sql<{ user_version: number }>`PRAGMA user_version`,
      );
      if (version > 1) throw new Error("The desktop database requires a newer Scope version.");
      await this.run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TABLE IF NOT EXISTS preferences (
          name TEXT PRIMARY KEY, document TEXT NOT NULL CHECK (json_valid(document))
        ) STRICT`;
            yield* sql`PRAGMA user_version = 1`;
          }),
        ),
      );
      const [row] = await this.run(
        sql<{ document: string }>`SELECT document FROM preferences WHERE name = 'settings'`,
      );
      if (row) this.saved = decode(SavedSettings, JSON.parse(row.document));
      else {
        const legacy = await readFile(join(this.directory, "settings.json"), "utf8").catch(
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (legacy !== null) {
          const old = decode(LegacySettings, JSON.parse(legacy));
          if (old.apiKey || old.hubToken) {
            if (this.credentials.kind !== "keychain" || !this.decodeLegacySecret)
              throw new Error(
                "Open this desktop profile on macOS to migrate its saved credentials to Keychain.",
              );
            const secrets = { ...(await this.credentials.read()) };
            for (const name of ["apiKey", "hubToken"] as const)
              if (old[name] && !secrets[name])
                secrets[name] = await this.decodeLegacySecret(Buffer.from(old[name], "base64"));
            await this.credentials.write(secrets);
          }
          this.saved = {
            version: 1,
            endpoint: old.endpoint,
            provider: old.provider,
            model: old.model,
          };
        }
        await this.run(
          sql`INSERT INTO preferences(name, document) VALUES ('settings', ${JSON.stringify(this.saved)})`,
        );
        if (legacy !== null) await unlink(join(this.directory, "settings.json"));
      }
      if (initial.endpoint)
        this.saved = { ...this.saved, endpoint: validateEndpoint(initial.endpoint) };
      if (initial.hubToken) this.sessionSecrets.hubToken = initial.hubToken;
      await this.refreshPresence();
    } catch (error) {
      await this.runtime.dispose();
      throw error;
    }
  }

  private run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    if (!this.runtime) throw new Error("Desktop preferences are not open.");
    return this.runtime.runPromise(effect);
  }

  private async refreshPresence(): Promise<void> {
    try {
      const secrets = await this.credentials.read();
      this.presence = {
        hasHubToken: Boolean(this.sessionSecrets.hubToken || secrets.hubToken),
        hasApiKey: Boolean(secrets.apiKey),
      };
      this.credentialError = undefined;
    } catch {
      this.credentialError = "Key status is unavailable. Unlock macOS Keychain and try again.";
    }
  }

  view(): SettingsView {
    return {
      endpoint: this.saved.endpoint,
      provider: this.saved.provider,
      model: this.saved.model,
      ...this.presence,
      keyStorage: this.credentials.kind,
      ...(this.credentialError ? { credentialError: this.credentialError } : {}),
    };
  }

  async secret(name: keyof Secrets): Promise<string | undefined> {
    return this.sessionSecrets[name] ?? (await this.credentials.read())[name];
  }

  private enqueue<A>(write: () => Promise<A>): Promise<A> {
    const task = this.pending.then(write);
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  update(value: SettingsUpdate): Promise<SettingsView> {
    return this.enqueue(async () => {
      const input = decodeSettingsUpdate(value);
      const next = { ...this.saved };
      if (input.endpoint !== undefined) next.endpoint = validateEndpoint(input.endpoint);
      if (input.removeApiKey && input.apiKey)
        throw new Error("Choose either replacing or removing the key.");
      if (input.apiKey !== undefined || input.hubToken !== undefined || input.removeApiKey) {
        const secrets = { ...(await this.credentials.read()) };
        if (input.removeApiKey) delete secrets.apiKey;
        for (const name of ["hubToken", "apiKey"] as const) {
          const secret = input[name]?.trim();
          if (secret !== undefined) {
            if (!secret || /[\r\n]/.test(secret)) throw new Error("Enter a key on one line.");
            secrets[name] = secret;
          }
        }
        await this.credentials.write(secrets);
        if (input.hubToken !== undefined) delete this.sessionSecrets.hubToken;
      }
      await this.run(
        this
          .sql!`UPDATE preferences SET document = ${JSON.stringify(next)} WHERE name = 'settings'`,
      );
      this.saved = next;
      await this.refreshPresence();
      return this.view();
    });
  }

  async workspace(): Promise<Workspace | null> {
    const [row] = await this.run(
      this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'workspace'`,
    );
    return row ? decode(Workspace, JSON.parse(row.document)) : null;
  }

  saveWorkspace(value: unknown): Promise<void> {
    const workspace = decode(Workspace, value);
    if (
      new Set(workspace.tabs).size !== workspace.tabs.length ||
      (workspace.selected !== null && !workspace.tabs.includes(workspace.selected))
    )
      throw new Error("Invalid workspace selection.");
    return this.enqueue(async () => {
      await this.run(this
        .sql!`INSERT INTO preferences(name, document) VALUES ('workspace', ${JSON.stringify(workspace)})
        ON CONFLICT(name) DO UPDATE SET document = excluded.document`);
    });
  }

  async close(): Promise<void> {
    await this.pending;
    await this.runtime?.dispose();
  }
}
