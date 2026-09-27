import { DatabaseMaintenance } from "@irudd-scope/sqlite";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { Schema } from "effect";
import { decode, decodeLocalConnection, validateEndpoint } from "@irudd-scope/protocol";
import { RemoteId, RemoteName, pairingUrl } from "@irudd-scope/protocol/remote";

const Configuration = Schema.Struct({
  id: RemoteId,
  name: RemoteName,
  endpoint: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  connectionFile: Schema.String,
});
type Configuration = typeof Configuration.Type;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export class HubState {
  private constructor(
    private readonly database: DatabaseSync,
    readonly maintenance: DatabaseMaintenance,
  ) {}

  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "hub.db");
    const database = new DatabaseSync(filename);
    await chmod(filename, 0o600);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 50;");
    const version = database.prepare("PRAGMA user_version").get()!.user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      database.close();
      throw new Error("The hub database requires a newer Scope version.");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      PRAGMA user_version = 2;`);
    return new HubState(database, new DatabaseMaintenance(filename, "hub.db"));
  }

  private get(name: string): string | undefined {
    return this.database.prepare("SELECT value FROM settings WHERE name = ?").get(name)?.value as
      | string
      | undefined;
  }
  private set(name: string, value: string) {
    this.database
      .prepare(
        "INSERT INTO settings VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      )
      .run(name, value);
  }
  configuration(): Configuration {
    const value = this.get("configuration");
    if (!value) throw new Error("Run irudd-scope setup before starting the hub.");
    return decode(Configuration, JSON.parse(value));
  }
  async configure(input: Omit<Configuration, "id" | "name">) {
    validateEndpoint(input.endpoint);
    const previous = this.get("configuration");
    const configuration = decode(Configuration, {
      ...input,
      id: previous ? decode(Configuration, JSON.parse(previous)).id : randomUUID(),
      name: hostname().slice(0, 160),
    });
    const existing = await readFile(input.connectionFile, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    let token = secret();
    if (existing) {
      const connection = decodeLocalConnection(JSON.parse(existing));
      if (!this.authenticate(connection.token, "local"))
        throw new Error(
          "A different Scope installation owns the connection file. Set SCOPE_CONNECTION_FILE to a separate path.",
        );
      token = connection.token;
    }
    this.set("local", hash(token));
    this.set("configuration", JSON.stringify(configuration));
    await mkdir(dirname(input.connectionFile), { recursive: true, mode: 0o700 });
    const temporary = `${input.connectionFile}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, endpoint: `http://127.0.0.1:${input.port}`, token }),
      { mode: 0o600 },
    );
    await rename(temporary, input.connectionFile);
    return configuration;
  }
  authenticate(token: string, kind: "local" | "desktop" | "pair") {
    const expected = this.get(kind);
    if (!expected || token.length > 128) return false;
    return timingSafeEqual(Buffer.from(hash(token)), Buffer.from(expected));
  }
  pairUrl() {
    if (this.get("desktop"))
      throw new Error(
        "This hub is already paired. Run irudd-scope hub unpair before pairing another Mac.",
      );
    const token = secret();
    this.set("pair", hash(token));
    this.set("pairExpires", String(Date.now() + 10 * 60_000));
    return pairingUrl(this.configuration().endpoint, token);
  }
  pair(token: string, name: string) {
    if (
      !this.authenticate(token, "pair") ||
      Date.now() >= Number(this.get("pairExpires") ?? 0) ||
      this.get("desktop")
    )
      throw new Error(
        "The pairing link is expired or already used. Run irudd-scope pair for a new link.",
      );
    const credential = secret();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.set("desktop", hash(credential));
      this.set("desktopName", name);
      this.database.prepare("DELETE FROM settings WHERE name IN ('pair', 'pairExpires')").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const { id, name: hubName } = this.configuration();
    return { id, name: hubName, token: credential };
  }
  unpair() {
    this.database
      .prepare(
        "DELETE FROM settings WHERE name IN ('desktop', 'desktopName', 'pair', 'pairExpires')",
      )
      .run();
  }
  status() {
    const { id, name, endpoint, port } = this.configuration();
    return { id, name, endpoint, port, pairedMac: this.get("desktopName") ?? null };
  }
  close() {
    this.database.close();
  }
}
