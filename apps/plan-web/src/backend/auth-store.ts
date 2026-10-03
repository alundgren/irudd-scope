import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Actor } from "../contracts.ts";

export const fakeIdentities = ["Alex", "Blair", "Casey"] as const;
export const authScope = "plans:read plans:write";
export const grantLifetime = 600_000;
export const tokenLifetime = 28_800_000;
export function secret() {
  return randomBytes(32).toString("base64url");
}
export function digest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
export type Grant = {
  id: string;
  kind: "pairing" | "oauth";
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  agent: string;
  audience: string;
  expires: number;
  identity?: string;
  redeemed: boolean;
  deviceHash?: string;
  codeHash?: string;
  csrfHash?: string;
  interval: number;
  nextPoll: number;
  clientId?: string;
  redirectUri?: string;
  challenge?: string;
  state?: string;
};
export type Credential = { actor: Actor; audience: string; expires: number; agent: string };
type Client = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
};

export class AuthStore {
  private database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS mcp_grants (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_credentials (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      this.database.exec("PRAGMA busy_timeout=5000");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  close() {
    this.database.close();
  }
  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  private prune() {
    const cutoff = Date.now() - grantLifetime;
    this.database.prepare("DELETE FROM mcp_grants WHERE expires < ?").run(cutoff);
    this.database.prepare("DELETE FROM mcp_credentials WHERE expires < ?").run(Date.now());
  }
  create(grant: Grant) {
    this.transaction(() => {
      this.prune();
      const count = this.database.prepare("SELECT count(*) AS count FROM mcp_grants").get()!;
      if (Number(count.count) >= 1000)
        throw new Error("Too many pending authorizations. Try again later.");
      this.database
        .prepare("INSERT INTO mcp_grants VALUES (?, ?, ?)")
        .run(grant.id, grant.expires, JSON.stringify(grant));
    });
  }
  get(id: string): Grant | undefined {
    const row = this.database.prepare("SELECT data FROM mcp_grants WHERE id=?").get(id);
    if (!row) return;
    const grant = JSON.parse(String(row.data)) as Grant;
    if (
      grant.expires <= Date.now() &&
      !grant.redeemed &&
      (grant.status === "pending" || grant.status === "approved")
    ) {
      grant.status = "expired";
      this.save(grant);
    }
    return grant;
  }
  private save(grant: Grant) {
    this.database
      .prepare("INSERT OR REPLACE INTO mcp_grants VALUES (?, ?, ?)")
      .run(grant.id, grant.expires, JSON.stringify(grant));
  }
  browser(id: string) {
    return this.transaction(() => {
      const grant = this.get(id);
      if (!grant) return;
      const csrf = secret();
      grant.csrfHash = digest(csrf);
      this.save(grant);
      return { grant, csrf };
    });
  }
  decide(id: string, csrf: string, action: string, identity: string) {
    return this.transaction(() => {
      const grant = this.get(id);
      if (!grant || grant.status !== "pending" || grant.csrfHash !== digest(csrf)) return;
      if (!["approve", "deny", "cancel"].includes(action)) return;
      if (action === "approve" && !fakeIdentities.some((name) => name === identity)) return;
      grant.status = action === "approve" ? "approved" : action === "deny" ? "denied" : "cancelled";
      grant.identity = action === "approve" ? identity : undefined;
      const code = action === "approve" && grant.kind === "oauth" ? secret() : undefined;
      grant.codeHash = code ? digest(code) : undefined;
      grant.csrfHash = undefined;
      this.save(grant);
      return { grant, code };
    });
  }
  cancel(id: string, device: string) {
    return this.transaction(() => {
      const grant = this.get(id);
      if (
        !grant ||
        grant.deviceHash !== digest(device) ||
        grant.redeemed ||
        !["pending", "approved"].includes(grant.status)
      )
        return false;
      grant.status = "cancelled";
      this.save(grant);
      return true;
    });
  }
  private issue(grant: Grant) {
    this.prune();
    const count = this.database.prepare("SELECT count(*) AS count FROM mcp_credentials").get()!;
    if (Number(count.count) >= 1000) return { error: "temporarily_unavailable" };
    const token = secret();
    const credential: Credential = {
      actor: {
        id: `fake-user-${grant.identity!.toLowerCase()}`,
        name: `${grant.identity} / ${grant.agent}`,
        kind: "agent",
      },
      audience: grant.audience,
      agent: grant.agent,
      expires: Date.now() + tokenLifetime,
    };
    this.database
      .prepare("INSERT INTO mcp_credentials VALUES (?, ?, ?)")
      .run(digest(token), credential.expires, JSON.stringify(credential));
    grant.redeemed = true;
    this.save(grant);
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: tokenLifetime / 1000,
      scope: authScope,
    };
  }
  poll(id: string, device: string, audience: string) {
    return this.transaction(() => {
      const grant = this.get(id);
      if (
        !grant ||
        grant.kind !== "pairing" ||
        grant.deviceHash !== digest(device) ||
        grant.audience !== audience ||
        grant.redeemed
      )
        return { error: "invalid_grant" };
      if (grant.status === "expired") return { error: "expired_token" };
      if (grant.status === "denied" || grant.status === "cancelled")
        return { error: "access_denied" };
      if (Date.now() < grant.nextPoll) {
        grant.interval += 5000;
        grant.nextPoll = Date.now() + grant.interval;
        this.save(grant);
        return { error: "slow_down", interval: grant.interval / 1000 };
      }
      grant.nextPoll = Date.now() + grant.interval;
      this.save(grant);
      return grant.status === "approved" ? this.issue(grant) : { error: "authorization_pending" };
    });
  }
  redeem(input: URLSearchParams, audience: string) {
    return this.transaction(() => {
      const rows = this.database
        .prepare("SELECT data FROM mcp_grants WHERE expires > ?")
        .all(Date.now());
      const grant = rows
        .map((row) => JSON.parse(String(row.data)) as Grant)
        .find((entry) => entry.codeHash === digest(input.get("code") ?? ""));
      const verifier = input.get("code_verifier") ?? "";
      if (
        !grant ||
        grant.kind !== "oauth" ||
        grant.redeemed ||
        grant.status !== "approved" ||
        grant.clientId !== input.get("client_id") ||
        grant.redirectUri !== input.get("redirect_uri") ||
        grant.audience !== audience ||
        input.get("resource") !== audience ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        grant.challenge !== digest(verifier)
      )
        return { error: "invalid_grant" };
      return this.issue(grant);
    });
  }
  verify(token: string, audience: string): Credential | undefined {
    const row = this.database
      .prepare("SELECT data FROM mcp_credentials WHERE hash=? AND expires>?")
      .get(digest(token), Date.now());
    const credential = row ? (JSON.parse(String(row.data)) as Credential) : undefined;
    return credential?.audience === audience ? credential : undefined;
  }
  revoke(token: string) {
    this.database.prepare("DELETE FROM mcp_credentials WHERE hash=?").run(digest(token));
  }
  register(name: string, redirects: string[]): Client {
    return this.transaction(() => {
      const count = this.database.prepare("SELECT count(*) AS count FROM mcp_clients").get()!;
      if (Number(count.count) >= 100) throw new Error("Client registration limit reached.");
      const client: Client = {
        client_id: secret(),
        client_name: name,
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      };
      this.database
        .prepare("INSERT INTO mcp_clients VALUES (?, ?)")
        .run(client.client_id, JSON.stringify(client));
      return client;
    });
  }
  client(id: string): Client | undefined {
    const row = this.database.prepare("SELECT data FROM mcp_clients WHERE id=?").get(id);
    return row ? (JSON.parse(String(row.data)) as Client) : undefined;
  }
}
