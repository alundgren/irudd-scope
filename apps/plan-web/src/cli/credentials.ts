import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SavedCredential = { endpoint: string; token: string; expires: number };
export function credentialStore() {
  const directory = process.env.PLAN_WEB_CLI_HOME ?? join(homedir(), ".config", "plan-web");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Credential directory must not be a symbolic link.");
  chmodSync(directory, 0o700);
  const path = join(directory, "credentials.sqlite");
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Credential file must not be a symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(
    "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS credentials (endpoint TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL)",
  );
  return {
    get(endpoint: string, allowExpired = false): SavedCredential {
      const row = database
        .prepare("SELECT token,expires FROM credentials WHERE endpoint=?")
        .get(endpoint);
      if (!row || (!allowExpired && Number(row.expires) <= Date.now()))
        throw new Error("Log in to this server with plan-web login first.");
      return { endpoint, token: String(row.token), expires: Number(row.expires) };
    },
    save(value: SavedCredential) {
      database
        .prepare("INSERT OR REPLACE INTO credentials VALUES (?, ?, ?)")
        .run(value.endpoint, value.token, value.expires);
    },
    remove(endpoint: string) {
      database.prepare("DELETE FROM credentials WHERE endpoint=?").run(endpoint);
    },
    close() {
      database.close();
    },
  };
}
