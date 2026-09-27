import { createHash } from "node:crypto";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";

const Secrets = Schema.Struct({
  hubToken: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
});
export type Secrets = typeof Secrets.Type;
export type CredentialStore = {
  kind: "keychain" | "session";
  read: () => Promise<Secrets>;
  write: (secrets: Secrets) => Promise<void>;
};

export function memoryCredentials(): CredentialStore {
  let secrets: Secrets = {};
  return {
    kind: "session",
    read: async () => ({ ...secrets }),
    write: async (next) => {
      secrets = { ...next };
    },
  };
}

export async function macCredentials(directory: string): Promise<CredentialStore> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const profile = createHash("sha256").update(directory).digest("hex");
  const entry = new AsyncEntry("alundgren.irudd-scope", profile);
  return {
    kind: "keychain",
    read: async () => {
      try {
        const value = await entry.getPassword();
        return value === undefined ? {} : decode(Secrets, JSON.parse(value));
      } catch {
        throw new Error(
          "Cannot read Scope credentials. Unlock macOS Keychain and allow Scope access.",
        );
      }
    },
    write: async (secrets) => {
      try {
        if (secrets.apiKey || secrets.hubToken)
          await entry.setPassword(JSON.stringify(decode(Secrets, secrets)));
        else await entry.deleteCredential();
      } catch {
        throw new Error(
          "Cannot update Scope credentials in macOS Keychain. Unlock it and try again.",
        );
      }
    },
  };
}
