import { DatabaseMaintenance } from "@irudd-scope/sqlite";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { decode } from "@irudd-scope/protocol";
import { memoryCredentials, type CredentialStore } from "./credentials.ts";

import {
  Appearance,
  decodeSettingsUpdate,
  type SettingsUpdate,
  type SettingsView,
} from "./settings.ts";
import {
  Uuid,
  TabGroup,
  importWorkspace,
  importedClosedArtifacts,
  type Workspace,
} from "./workspace/contract.ts";
import { DIAGRAM_MODEL, DIAGRAM_PROVIDER } from "./plugins/diagram/provider-settings.ts";
import { Remote, Remotes } from "./remote-contract.ts";
import { RemoteToken } from "@irudd-scope/protocol/remote";

const SavedSettings = Schema.Struct({
  version: Schema.Literal(2),
  appearance: Schema.optionalKey(Appearance),
  diagramGenerationEnabled: Schema.optionalKey(Schema.Boolean),
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
  maintenance!: DatabaseMaintenance;
  private saved: typeof SavedSettings.Type = {
    version: 2,
    provider: DIAGRAM_PROVIDER,
    model: DIAGRAM_MODEL,
  };
  private runtime?: ReturnType<typeof databaseRuntime>;
  private sql?: SqliteClient.SqliteClient;
  private hasApiKey: boolean | null = null;
  private credentialError?: string;
  private legacyApiKey?: string;
  private pending = Promise.resolve();
  readonly filename: string;

  constructor(
    private readonly directory: string,
    private readonly credentials: CredentialStore = memoryCredentials(),
    private readonly decodeLegacySecret?: (bytes: Buffer) => Promise<string>,
  ) {
    this.filename = join(directory, "desktop.db");
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = join(this.directory, "desktop.db");
    this.runtime = databaseRuntime(filename);
    try {
      const sql = (this.sql = await this.runtime.runPromise(SqliteClient.SqliteClient));
      await chmod(filename, 0o600);
      await this.run(sql`PRAGMA busy_timeout = 50`);
      const [{ user_version: version }] = await this.run(
        sql<{ user_version: number }>`PRAGMA user_version`,
      );
      if (version > 6) throw new Error("The desktop database requires a newer Scope version.");
      await this.run(
        sql`CREATE TABLE IF NOT EXISTS preferences (
          name TEXT PRIMARY KEY, document TEXT NOT NULL CHECK (json_valid(document))
        ) STRICT`,
      );
      const [row] = await this.run(
        sql<{ document: string }>`SELECT document FROM preferences WHERE name = 'settings'`,
      );
      const legacy = await readFile(join(this.directory, "settings.json"), "utf8").catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        },
      );
      const old = legacy === null ? undefined : decode(LegacySettings, JSON.parse(legacy));
      this.legacyApiKey = old?.apiKey;
      const saved = row ? decode(LegacySettings, JSON.parse(row.document)) : old;
      if (saved) {
        this.saved = {
          version: 2,
          provider: saved.provider,
          model: saved.model,
          appearance: saved.appearance ?? "system",
          diagramGenerationEnabled: saved.diagramGenerationEnabled ?? false,
        };
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
              const value = JSON.parse(workspace.document);
              if (!("version" in value)) {
                const imported = importWorkspace(value);
                const closed = importedClosedArtifacts(value).map((artifactId) => ({
                  id: crypto.randomUUID(),
                  groupId: imported.groups[0].id,
                  type: "file",
                  title: artifactId,
                  state: { version: 1, data: { artifactId } },
                }));
                yield* sql`UPDATE preferences SET document = ${JSON.stringify({ ...imported, version: 2, closed })} WHERE name = 'workspace'`;
              }
            }
            yield* sql`PRAGMA user_version = 6`;
          }),
        ),
      );
      if (legacy !== null && !this.legacyApiKey)
        await unlink(join(this.directory, "settings.json"));
      this.maintenance = new DatabaseMaintenance(filename, "desktop.db");
    } catch (error) {
      await this.runtime.dispose();
      throw error;
    }
  }

  private async run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    await this.maintenance?.idle();
    if (!this.runtime) throw new Error("Desktop preferences are not open.");
    return this.runtime.runPromise(effect);
  }

  private async readDiagramCredentials() {
    const secrets = { ...(await this.credentials.read()) };
    if (this.legacyApiKey) {
      if (!secrets.apiKey) {
        if (this.credentials.kind !== "keychain" || !this.decodeLegacySecret)
          throw new Error(
            "Open this desktop profile on macOS to migrate its saved credentials to Keychain.",
          );
        secrets.apiKey = await this.decodeLegacySecret(Buffer.from(this.legacyApiKey, "base64"));
        await this.credentials.write(secrets);
      }
      await unlink(join(this.directory, "settings.json"));
      this.legacyApiKey = undefined;
    }
    this.hasApiKey = Boolean(secrets.apiKey);
    this.credentialError = undefined;
    return secrets;
  }

  diagramSettings(): Promise<SettingsView> {
    return this.enqueue(async () => {
      if (this.saved.diagramGenerationEnabled) {
        try {
          await this.readDiagramCredentials();
        } catch {
          this.credentialError = "Key status is unavailable. Retry to request access again.";
        }
      }
      return this.settings();
    });
  }

  settings(): SettingsView {
    return {
      appearance: this.saved.appearance ?? "system",
      diagramGenerationEnabled: this.saved.diagramGenerationEnabled ?? false,
      provider: this.saved.provider,
      model: this.saved.model,
      hasApiKey: this.hasApiKey,
      keyStorage: this.credentials.kind,
      ...(this.credentialError ? { credentialError: this.credentialError } : {}),
    };
  }

  secret(name: "apiKey"): Promise<string | undefined> {
    return this.enqueue(async () => {
      if (!this.saved.diagramGenerationEnabled)
        throw new Error("Enable diagram generation in Settings first.");
      return (await this.readDiagramCredentials())[name];
    });
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
      if (input.diagramGenerationEnabled !== undefined)
        next.diagramGenerationEnabled = input.diagramGenerationEnabled;
      if (input.removeApiKey && input.apiKey)
        throw new Error("Choose either replacing or removing the key.");
      if (input.apiKey !== undefined || input.removeApiKey) {
        if (!next.diagramGenerationEnabled)
          throw new Error("Enable diagram generation in Settings first.");
        const secrets = await this.readDiagramCredentials();
        if (input.removeApiKey) delete secrets.apiKey;
        const secret = input.apiKey?.trim();
        if (secret !== undefined) {
          if (!secret || /[\r\n]/.test(secret)) throw new Error("Enter a key on one line.");
          secrets.apiKey = secret;
        }
        await this.credentials.write(secrets);
        this.hasApiKey = Boolean(secrets.apiKey);
      }
      await this.run(
        this
          .sql!`UPDATE preferences SET document = ${JSON.stringify(next)} WHERE name = 'settings'`,
      );
      this.saved = next;
      if (!next.diagramGenerationEnabled) {
        this.hasApiKey = null;
        this.credentialError = undefined;
      }
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

  async legacyWorkspace(): Promise<Workspace | null> {
    await this.pending;
    const [row] = await this.run(
      this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'workspace'`,
    );
    return row ? importWorkspace(JSON.parse(row.document)) : null;
  }

  async closedArtifacts(): Promise<string[]> {
    const [row] = await this.run(
      this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'workspace'`,
    );
    return row ? importedClosedArtifacts(JSON.parse(row.document)) : [];
  }

  async legacyDrafts(): Promise<readonly { artifact_id: string; document: string }[]> {
    return this.run(
      this.sql!<{ artifact_id: string; document: string }>`SELECT * FROM diagram_drafts`,
    );
  }

  async layout(): Promise<Pick<Workspace, "groups" | "selected"> | null> {
    await this.pending;
    const [row] = await this.run(
      this.sql!<{
        document: string;
      }>`SELECT document FROM preferences WHERE name = 'workspace_layout'`,
    );
    return row
      ? decode(
          Schema.Struct({ groups: Schema.Array(TabGroup), selected: Schema.NullOr(Uuid) }),
          JSON.parse(row.document),
        )
      : null;
  }

  saveLayout(layout: Pick<Workspace, "groups" | "selected">): Promise<void> {
    return this.enqueue(async () => {
      await this.run(
        this
          .sql!`INSERT INTO preferences(name, document) VALUES ('workspace_layout', ${JSON.stringify(layout)}) ON CONFLICT(name) DO UPDATE SET document = excluded.document`,
      );
    });
  }

  finishTabImport(): Promise<void> {
    return this.enqueue(async () => {
      const sql = this.sql!;
      await this.run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM preferences WHERE name = 'workspace'`;
            yield* sql`DELETE FROM diagram_drafts`;
          }),
        ),
      );
    });
  }

  async close(): Promise<void> {
    await this.maintenance?.close();
    await this.pending;
    await this.runtime?.dispose();
  }
}
