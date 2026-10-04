import {
  RetroConfiguration,
  emptyRetroConfiguration,
  type RetroCommand,
} from "@irudd-scope/protocol/retro";
import { ScopeError } from "@irudd-scope/protocol";
import { createHash } from "node:crypto";
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
import { TransferName, TransferSecret } from "@irudd-scope/protocol/transfer";
import { ScopeDevice, ScopePeer, ScopePeers } from "./transfer/contract.ts";

const SavedSettings = Schema.Struct({
  version: Schema.Literal(2),
  appearance: Schema.optionalKey(Appearance),
  diagramGenerationEnabled: Schema.optionalKey(Schema.Boolean),
  voiceGenerationEnabled: Schema.optionalKey(Schema.Boolean),
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
      if (version > 7) throw new Error("The desktop database requires a newer Scope version.");
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
          voiceGenerationEnabled: saved.voiceGenerationEnabled ?? false,
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
            yield* sql`CREATE TABLE IF NOT EXISTS voice_requests (
              request_id TEXT PRIMARY KEY,
              payload_hash TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              receipt TEXT NOT NULL CHECK (json_valid(receipt)),
              audio BLOB
            ) STRICT`;
            yield* sql`PRAGMA user_version = 7`;
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

  async retroConfiguration(): Promise<RetroConfiguration> {
    const [row] = await this.run(
      this.sql!<{
        document: string;
      }>`SELECT document FROM preferences WHERE name = 'retro-configuration'`,
    );
    return row ? decode(RetroConfiguration, JSON.parse(row.document)) : emptyRetroConfiguration();
  }

  saveRetroConfiguration(
    input: Extract<RetroCommand, { action: "configure" }>,
  ): Promise<RetroConfiguration> {
    const command = decode(RetroConfiguration, input.configuration);
    const sql = this.sql!;
    const payload = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const task = this.pending.then(() =>
      this.run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TABLE IF NOT EXISTS retro_configuration_receipts(request_id TEXT PRIMARY KEY,payload TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document))) STRICT`;
            const [receipt] = yield* sql<{
              payload: string;
              document: string;
            }>`SELECT payload,document FROM retro_configuration_receipts WHERE request_id = ${input.requestId}`;
            if (receipt) {
              if (receipt.payload !== payload)
                return yield* Effect.fail(
                  new ScopeError(409, "This request ID was already used with different content."),
                );
              return decode(RetroConfiguration, JSON.parse(receipt.document));
            }
            const [row] = yield* sql<{
              document: string;
            }>`SELECT document FROM preferences WHERE name = 'retro-configuration'`;
            const prior = row
              ? decode(RetroConfiguration, JSON.parse(row.document))
              : emptyRetroConfiguration();
            if (
              prior.version !== input.expectedVersion ||
              command.version !== input.expectedVersion
            )
              return yield* Effect.fail(
                new ScopeError(
                  409,
                  "Retrospective configuration changed. Read the current version.",
                ),
              );
            if (
              new Set(command.sources.map((s) => s.id)).size !== command.sources.length ||
              new Set(command.repositories.map((r) => r.repository)).size !==
                command.repositories.length ||
              new Set(command.memory.destinations.map((d) => d.id)).size !==
                command.memory.destinations.length
            )
              return yield* Effect.fail(
                new ScopeError(400, "Source, repository and destination IDs must be distinct."),
              );
            for (const source of command.sources)
              if (
                new Set(source.runtimes).size !== source.runtimes.length ||
                source.runtimes.length === 0
              )
                return yield* Effect.fail(
                  new ScopeError(400, "Configure distinct nonempty runtime selections."),
                );
            for (const destination of command.memory.destinations) {
              if (destination.type === "claude-memory" && destination.scope !== "project")
                return yield* Effect.fail(
                  new ScopeError(
                    400,
                    "Claude memory destinations require their project repository.",
                  ),
                );
              if (destination.type === "okf" && !destination.path.startsWith("/"))
                return yield* Effect.fail(
                  new ScopeError(
                    400,
                    "OKF destinations store an absolute bundle root. Verify the destination again.",
                  ),
                );
              if (!command.sources.some((s) => s.id === destination.sourceId))
                return yield* Effect.fail(
                  new ScopeError(400, "Destination source is not configured."),
                );
              if ((destination.scope === "project") !== !!destination.repository)
                return yield* Effect.fail(
                  new ScopeError(
                    400,
                    "Project destinations require a repository; operator destinations omit it.",
                  ),
                );
            }
            const result = { ...command, version: prior.version + 1 };
            yield* sql`INSERT INTO preferences(name,document) VALUES ('retro-configuration',${JSON.stringify(result)}) ON CONFLICT(name) DO UPDATE SET document = excluded.document`;
            yield* sql`INSERT INTO retro_configuration_receipts(request_id,payload,document) VALUES (${input.requestId},${payload},${JSON.stringify(result)})`;
            return result;
          }),
        ),
      ),
    );
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async readProviderCredentials() {
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

  providerSettings(): Promise<SettingsView> {
    return this.enqueue(async () => {
      try {
        await this.readProviderCredentials();
      } catch {
        this.credentialError = "Key status is unavailable. Retry to request access again.";
      }
      return this.settings();
    });
  }

  settings(): SettingsView {
    return {
      appearance: this.saved.appearance ?? "system",
      diagramGenerationEnabled: this.saved.diagramGenerationEnabled ?? false,
      voiceGenerationEnabled: this.saved.voiceGenerationEnabled ?? false,
      provider: this.saved.provider,
      model: this.saved.model,
      hasApiKey: this.hasApiKey,
      keyStorage: this.credentials.kind,
      ...(this.credentialError ? { credentialError: this.credentialError } : {}),
    };
  }

  secret(name: "apiKey"): Promise<string | undefined> {
    return this.enqueue(async () => {
      return (await this.readProviderCredentials())[name];
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
      if (input.voiceGenerationEnabled !== undefined)
        next.voiceGenerationEnabled = input.voiceGenerationEnabled;
      if (input.removeApiKey && input.apiKey)
        throw new Error("Choose either replacing or removing the key.");
      if (input.apiKey !== undefined || input.removeApiKey) {
        const secrets = await this.readProviderCredentials();
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
      return this.settings();
    });
  }

  voiceRows(): Promise<
    readonly { request_id: string; payload_hash: string; expires_at: number; receipt: string }[]
  > {
    return this.enqueue(() =>
      this.run(
        this.sql!<{
          request_id: string;
          payload_hash: string;
          expires_at: number;
          receipt: string;
        }>`SELECT request_id, payload_hash, expires_at, receipt FROM voice_requests`,
      ),
    );
  }

  saveVoice(
    requestId: string,
    payloadHash: string,
    expiresAt: number,
    receipt: string,
    audio?: Buffer,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.run(this
        .sql!`INSERT INTO voice_requests(request_id, payload_hash, expires_at, receipt, audio)
        VALUES (${requestId}, ${payloadHash}, ${expiresAt}, ${receipt}, ${audio ?? null})
        ON CONFLICT(request_id) DO UPDATE SET receipt = excluded.receipt,
        audio = COALESCE(excluded.audio, voice_requests.audio)`);
    });
  }

  voiceAudio(requestId: string): Promise<Uint8Array | null> {
    return this.enqueue(async () => {
      const [row] = await this.run(
        this.sql!<{
          audio: Uint8Array | null;
        }>`SELECT audio FROM voice_requests WHERE request_id = ${requestId}`,
      );
      return row?.audio ?? null;
    });
  }

  expireVoice(now: number): Promise<void> {
    return this.enqueue(async () => {
      await this.run(this.sql!`DELETE FROM voice_requests WHERE expires_at <= ${now}`);
    });
  }

  get credentialStorage(): "keychain" | "session" {
    return this.credentials.kind;
  }

  transferDevice(name?: string): Promise<ScopeDevice> {
    if (name !== undefined) decode(TransferName, name);
    return this.enqueue(async () => {
      const [row] = await this.run(
        this.sql!<{
          document: string;
        }>`SELECT document FROM preferences WHERE name = 'transfer-device'`,
      );
      const device = row
        ? decode(ScopeDevice, JSON.parse(row.document))
        : { deviceId: crypto.randomUUID(), name: name ?? "Scope" };
      const next = { ...device, name: name ?? device.name };
      await this.run(
        this
          .sql!`INSERT INTO preferences(name, document) VALUES ('transfer-device', ${JSON.stringify(next)}) ON CONFLICT(name) DO UPDATE SET document = excluded.document`,
      );
      return next;
    });
  }

  async scopePeers(): Promise<ScopePeer[]> {
    await this.pending;
    const [row] = await this.run(
      this.sql!<{ document: string }>`SELECT document FROM preferences WHERE name = 'scope-peers'`,
    );
    return row ? [...decode(ScopePeers, JSON.parse(row.document))] : [];
  }

  async transferKey(id: string): Promise<string | undefined> {
    await this.pending;
    return (await this.credentials.read()).transferKeys?.[id];
  }

  saveScopePeer(value: ScopePeer, secret: string): Promise<void> {
    const peer = decode(ScopePeer, value);
    decode(TransferSecret, secret);
    return this.enqueue(async () => {
      const [row] = await this.run(
        this.sql!<{
          document: string;
        }>`SELECT document FROM preferences WHERE name = 'scope-peers'`,
      );
      const peers = row ? [...decode(ScopePeers, JSON.parse(row.document))] : [];
      const secrets = await this.credentials.read();
      await this.credentials.write({
        ...secrets,
        transferKeys: { ...secrets.transferKeys, [peer.id]: secret },
      });
      const next = [...peers.filter((item) => item.id !== peer.id), peer];
      await this.run(
        this
          .sql!`INSERT INTO preferences(name, document) VALUES ('scope-peers', ${JSON.stringify(next)}) ON CONFLICT(name) DO UPDATE SET document = excluded.document`,
      );
    });
  }

  removeScopePeer(id: string): Promise<void> {
    return this.enqueue(async () => {
      const [row] = await this.run(
        this.sql!<{
          document: string;
        }>`SELECT document FROM preferences WHERE name = 'scope-peers'`,
      );
      const peers = row ? [...decode(ScopePeers, JSON.parse(row.document))] : [];
      const secrets = await this.credentials.read();
      const transferKeys = { ...secrets.transferKeys };
      delete transferKeys[id];
      await this.credentials.write({ ...secrets, transferKeys });
      await this.run(
        this
          .sql!`UPDATE preferences SET document = ${JSON.stringify(peers.filter((peer) => peer.id !== id))} WHERE name = 'scope-peers'`,
      );
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
