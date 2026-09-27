import { createHash } from "node:crypto";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";

const Secrets = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
});
const LegacySecrets = Schema.Struct({
  ...Secrets.fields,
  hubToken: Schema.optionalKey(Schema.String),
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
        if (value === undefined) return {};
        const secrets = decode(LegacySecrets, JSON.parse(value));
        return secrets.apiKey === undefined ? {} : { apiKey: secrets.apiKey };
      } catch {
        throw new Error(
          "Cannot read Scope credentials. Unlock macOS Keychain and allow Scope access.",
        );
      }
    },
    write: async (secrets) => {
      try {
        if (secrets.apiKey) await entry.setPassword(JSON.stringify(decode(Secrets, secrets)));
        else await entry.deleteCredential();
      } catch {
        throw new Error(
          "Cannot update Scope credentials in macOS Keychain. Unlock it and try again.",
        );
      }
    },
  };
}
