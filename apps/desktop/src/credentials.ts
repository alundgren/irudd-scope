import { createHash } from "node:crypto";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { credentialHelperEntry } from "./credential-helper.ts";

const Secrets = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
  remoteTokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  sharingTokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
    read: async () => structuredClone(secrets),
    write: async (next) => {
      secrets = structuredClone(next);
    },
  };
}

export async function macCredentials(directory: string, helper?: string): Promise<CredentialStore> {
  const profile = createHash("sha256").update(directory).digest("hex");
  if (helper) return keychainCredentials(credentialHelperEntry(helper, profile));
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return keychainCredentials(new AsyncEntry("alundgren.irudd-scope", profile));
}

type KeychainEntry = {
  getPassword: () => Promise<string | null | undefined>;
  setPassword: (value: string) => Promise<void>;
  deleteCredential: () => Promise<boolean>;
};

export function keychainCredentials(entry: KeychainEntry): CredentialStore {
  return {
    kind: "keychain",
    read: async () => {
      let value: string | null | undefined;
      try {
        value = await entry.getPassword();
      } catch (cause) {
        throw new Error("Could not read Scope credentials from macOS Keychain.", { cause });
      }
      // The native binding returns null for a missing entry; its async types declare undefined.
      if (value === null || value === undefined) return {};
      try {
        const secrets = decode(LegacySecrets, JSON.parse(value));
        return {
          ...(secrets.apiKey === undefined ? {} : { apiKey: secrets.apiKey }),
          ...(secrets.remoteTokens === undefined ? {} : { remoteTokens: secrets.remoteTokens }),
          ...(secrets.sharingTokens === undefined ? {} : { sharingTokens: secrets.sharingTokens }),
        };
      } catch {
        throw new Error("Scope's saved Keychain entry has an invalid format.");
      }
    },
    write: async (secrets) => {
      try {
        if (
          secrets.apiKey ||
          Object.keys(secrets.remoteTokens ?? {}).length ||
          Object.keys(secrets.sharingTokens ?? {}).length
        )
          await entry.setPassword(JSON.stringify(decode(Secrets, secrets)));
        else await entry.deleteCredential();
      } catch (cause) {
        throw new Error("Could not update Scope credentials in macOS Keychain.", { cause });
      }
    },
  };
}
