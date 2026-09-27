import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ArtifactId, decode } from "@irudd-scope/protocol";
import { memoryCredentials, type CredentialStore } from "./credentials.ts";
import { DiagramDraft } from "./plugins/diagram/draft.ts";

import {
  Appearance,
  decodeSettingsUpdate,
  type SettingsUpdate,
  type SettingsView,
} from "./settings.ts";
import { decodeWorkspace, importWorkspace, type Workspace } from "./workspace/contract.ts";
import { validateTabState } from "./plugins/registry.ts";
import { DIAGRAM_MODEL, DIAGRAM_PROVIDER } from "./plugins/diagram/provider-settings.ts";
import { Remote, Remotes } from "./remote-contract.ts";
import { RemoteToken } from "@irudd-scope/protocol/remote";

const SavedSettings = Schema.Struct({
  version: Schema.Literal(2),
  appearance: Schema.optionalKey(Appearance),
  provider: Schema.Literal(DIAGRAM_PROVIDER),
  model: Schema.Literal(DIAGRAM_MODEL),
});
const LegacySettings = Schema.Struct({
  ...SavedSettings.fields,
  version: Schema.Literals([1, 2]),
  endpoint: Schema.optionalKey(Schema.String),
  hubToken: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
});
const databaseRuntime = (filename: string) => ManagedRuntime.make(SqliteClient.layer({ filename }));

export class DesktopStore {
  private saved: typeof SavedSettings.Type = {
    version: 2,
    provider: DIAGRAM_PROVIDER,
    model: DIAGRAM_MODEL,
  };
  private runtime?: ReturnType<typeof databaseRuntime>;
  private sql?: SqliteClient.SqliteClient;
  private presence = { hasApiKey: false };
  private credentialError?: string;
  private pending = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly credentials: CredentialStore = memoryCredentials(),
    private readonly decodeLegacySecret?: (bytes: Buffer) => Promise<string>,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = join(this.directory, "desktop.db");
    this.runtime = databaseRuntime(filename);
    try {
      const sql = (this.sql = await this.runtime.runPromise(SqliteClient.SqliteClient));
      await chmod(filename, 0o600);
      const [{ user_version: version }] = await this.run(
        sql<{ user_version: number }>`PRAGMA user_version`,
      );
      if (version > 5) throw new Error("The desktop database requires a newer Scope version.");
      await this.run(
        sql`CREATE TABLE IF NOT EXISTS preferences (
          name TEXT PRIMARY KEY, document TEXT NOT NULL CHECK (json_valid(document))
        ) STRICT`,
      );
      const [row] = await this.run(
        sql<{ document: string }>`SELECT document FROM preferences WHERE name = 'settings'`,
      );
      let legacy: string | null = null;
      if (row) {
        const saved = decode(LegacySettings, JSON.parse(row.document));
        this.saved = {
          version: 2,
          provider: saved.provider,
          model: saved.model,
          appearance: saved.appearance ?? "system",
        };
      } else {
        legacy = await readFile(join(this.directory, "settings.json"), "utf8").catch(
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (legacy !== null) {
          const old = decode(LegacySettings, JSON.parse(legacy));
          if (old.apiKey) {
            if (this.credentials.kind !== "keychain" || !this.decodeLegacySecret)
              throw new Error(
                "Open this desktop profile on macOS to migrate its saved credentials to Keychain.",
              );
            const secrets = { ...(await this.credentials.read()) };
            if (!secrets.apiKey)
              secrets.apiKey = await this.decodeLegacySecret(Buffer.from(old.apiKey, "base64"));
            await this.credentials.write(secrets);
          }
          this.saved = {
            version: 2,
            provider: old.provider,
            model: old.model,
            appearance: old.appearance ?? "system",
          };
        }
      }
      const document = JSON.stringify(this.saved);
      await this.run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO preferences(name, document) VALUES ('settings', ${document})
              ON CONFLICT(name) DO UPDATE SET document = excluded.document`;
            yield* sql`CREATE TABLE IF NOT EXISTS diagram_drafts (
              artifact_id TEXT PRIMARY KEY,
              document TEXT NOT NULL CHECK (json_valid(document))
            ) STRICT`;
            const [workspace] = yield* sql<{
              document: string;
            }>`SELECT document FROM preferences WHERE name = 'workspace'`;
            if (workspace) {
              const migrated = importWorkspace(JSON.parse(workspace.document));
              yield* sql`UPDATE preferences SET document = ${JSON.stringify(migrated)} WHERE name = 'workspace'`;
            }
            yield* sql`PRAGMA user_version = 5`;
          }),
        ),
      );
      if (legacy !== null) await unlink(join(this.directory, "settings.json"));
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
        hasApiKey: Boolean(secrets.apiKey),
      };
      this.credentialError = undefined;
    } catch {
      this.credentialError = "Key status is unavailable. Save settings to request access again.";
    }
  }

  settings(): SettingsView {
    return {
      appearance: this.saved.appearance ?? "system",
      provider: this.saved.provider,
      model: this.saved.model,
      ...this.presence,
      keyStorage: this.credentials.kind,
      ...(this.credentialError ? { credentialError: this.credentialError } : {}),
    };
  }

  async secret(name: "apiKey"): Promise<string | undefined> {
    return (await this.credentials.read())[name];
  }

  private enqueue<A>(write: () => Promise<A>): Promise<A> {
    const task = this.pending.then(write);
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  saveSettings(value: SettingsUpdate): Promise<SettingsView> {
    return this.enqueue(async () => {
      const input = decodeSettingsUpdate(value);
      const next = { ...this.saved };
      if (input.appearance !== undefined) next.appearance = input.appearance;
      if (input.removeApiKey && input.apiKey)
        throw new Error("Choose either replacing or removing the key.");
      if (input.apiKey !== undefined || input.removeApiKey) {
        const secrets = { ...(await this.credentials.read()) };
        if (input.removeApiKey) delete secrets.apiKey;
        const secret = input.apiKey?.trim();
        if (secret !== undefined) {
          if (!secret || /[\r\n]/.test(secret)) throw new Error("Enter a key on one line.");
          secrets.apiKey = secret;
        }
        await this.credentials.write(secrets);
      }
      await this.run(
        this
          .sql!`UPDATE preferences SET document = ${JSON.stringify(next)} WHERE name = 'settings'`,
      );
      this.saved = next;
      await this.refreshPresence();
      return this.settings();
    });
  }

  async remotes(): Promise<Remote[]> {
    await this.pending;
    const [row] = await this.run(
      this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'remotes'`,
    );
    return row ? [...decode(Remotes, JSON.parse(row.document))] : [];
  }

  async remoteToken(id: string): Promise<string | undefined> {
    await this.pending;
    return (await this.credentials.read()).remoteTokens?.[id];
  }

  saveRemote(value: Remote, token?: string): Promise<void> {
    const remote = decode(Remote, value);
    if (token !== undefined) decode(RemoteToken, token);
    return this.enqueue(async () => {
      const [row] = await this.run(
        this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'remotes'`,
      );
      const remotes = row ? [...decode(Remotes, JSON.parse(row.document))] : [];
      if (token !== undefined) {
        const secrets = await this.credentials.read();
        await this.credentials.write({
          ...secrets,
          remoteTokens: { ...secrets.remoteTokens, [remote.id]: token },
        });
      }
      const next = [...remotes.filter((item) => item.id !== remote.id), remote];
      await this.run(
        this
          .sql!`INSERT INTO preferences(name, document) VALUES ('remotes', ${JSON.stringify(next)}) ON CONFLICT(name) DO UPDATE SET document = excluded.document`,
      );
    });
  }

  removeRemote(id: string): Promise<void> {
    return this.enqueue(async () => {
      const [row] = await this.run(
        this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'remotes'`,
      );
      const remotes = row ? [...decode(Remotes, JSON.parse(row.document))] : [];
      const secrets = await this.credentials.read();
      const remoteTokens = { ...secrets.remoteTokens };
      delete remoteTokens[id];
      await this.credentials.write({ ...secrets, remoteTokens });
      await this.run(
        this
          .sql!`UPDATE preferences SET document = ${JSON.stringify(remotes.filter((item) => item.id !== id))} WHERE name = 'remotes'`,
      );
    });
  }

  async workspace(): Promise<Workspace | null> {
    await this.pending;
    const [row] = await this.run(
      this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'workspace'`,
    );
    return row ? decodeWorkspace(JSON.parse(row.document)) : null;
  }

  saveWorkspace(value: unknown): Promise<void> {
    const workspace = decodeWorkspace(value);
    for (const tab of [...workspace.tabs, ...workspace.closed]) validateTabState(tab, true);
    return this.enqueue(async () => {
      await this.run(this
        .sql!`INSERT INTO preferences(name, document) VALUES ('workspace', ${JSON.stringify(workspace)})
        ON CONFLICT(name) DO UPDATE SET document = excluded.document`);
    });
  }

  async diagramDraft(value: unknown): Promise<DiagramDraft | null> {
    const id = decode(ArtifactId, value);
    await this.pending;
    const [row] = await this.run(
      this.sql!<{
        document: string;
      }>`SELECT document FROM diagram_drafts WHERE artifact_id = ${id}`,
    );
    return row ? decode(DiagramDraft, JSON.parse(row.document)) : null;
  }

  saveDiagramDraft(artifactId: unknown, value: unknown): Promise<void> {
    const id = decode(ArtifactId, artifactId);
    const draft = decode(DiagramDraft, value);
    return this.enqueue(async () => {
      await this.run(this
        .sql!`INSERT INTO diagram_drafts(artifact_id, document) VALUES (${id}, ${JSON.stringify(draft)})
        ON CONFLICT(artifact_id) DO UPDATE SET document = excluded.document`);
    });
  }

  async close(): Promise<void> {
    await this.pending;
    await this.runtime?.dispose();
  }
}
