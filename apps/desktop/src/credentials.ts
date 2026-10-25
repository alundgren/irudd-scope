import { createHash } from "node:crypto";
import { Schema } from "effect";
import { GuestPairCredential } from "@irudd-scope/protocol/guest";
import { decode } from "@irudd-scope/protocol";
import { credentialHelperEntry } from "./credential-helper.ts";

const Secrets = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
  guestPairs: Schema.optionalKey(Schema.Record(Schema.String, GuestPairCredential)),
  remoteTokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const LegacySecrets = Schema.Struct({
  ...Secrets.fields,
  hubToken: Schema.optionalKey(Schema.String),
});
export type Secrets = typeof Secrets.Type;
export type CredentialStore = {
  kind: "keychain" | "windows" | "session";
  read: () => Promise<Secrets>;
  write: (secrets: Secrets) => Promise<void>;
};

export type CredentialDocument = {
  read: () => Promise<unknown>;
  write: (document: unknown) => Promise<void>;
};
export type CredentialFactory = (document: CredentialDocument) => CredentialStore;

type WindowsProtection = {
  isAsyncEncryptionAvailable: () => Promise<boolean>;
  encryptStringAsync: (value: string) => Promise<Buffer>;
  decryptStringAsync: (value: Buffer) => Promise<{ result: string }>;
};

const EncryptedCredentials = Schema.Struct({
  version: Schema.Literal(1),
  ciphertext: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
});

// Obsolete pairing data must not prevent access to unrelated protected credentials.
// Retained fields still pass through the strict credential decoder below.
function retainedCredentials(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const {
    transferKeys: _transferKeys,
    guestKey: _key,
    guestEndpoints: _endpoints,
    ...retained
  } = input as Record<string, unknown>;
  return retained;
}

export function windowsCredentials(protection: WindowsProtection): CredentialFactory {
  return (document) => {
    const available = async () => {
      if (!(await protection.isAsyncEncryptionAvailable()))
        throw new Error("Windows credential protection is unavailable. Retry key access.");
    };
    return {
      kind: "windows",
      read: async () => {
        const saved = await document.read();
        if (saved === undefined) return {};
        try {
          const encrypted = decode(EncryptedCredentials, saved);
          await available();
          const { result } = await protection.decryptStringAsync(
            Buffer.from(encrypted.ciphertext, "base64"),
          );
          return decode(Secrets, retainedCredentials(JSON.parse(result)));
        } catch (cause) {
          throw new Error("Could not read Scope credentials protected by Windows.", { cause });
        }
      },
      write: async (secrets) => {
        const next = decode(Secrets, secrets);
        if (
          !next.apiKey &&
          !Object.keys(next.guestPairs ?? {}).length &&
          !Object.keys(next.remoteTokens ?? {}).length
        ) {
          await document.write(undefined);
          return;
        }
        try {
          await available();
          const ciphertext = await protection.encryptStringAsync(JSON.stringify(next));
          await document.write({ version: 1, ciphertext: ciphertext.toString("base64") });
        } catch (cause) {
          throw new Error("Could not save Scope credentials with Windows protection.", { cause });
        }
      },
    };
  };
}

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
        const secrets = decode(LegacySecrets, retainedCredentials(JSON.parse(value)));
        return {
          ...(secrets.guestPairs === undefined ? {} : { guestPairs: secrets.guestPairs }),
          ...(secrets.apiKey === undefined ? {} : { apiKey: secrets.apiKey }),
          ...(secrets.remoteTokens === undefined ? {} : { remoteTokens: secrets.remoteTokens }),
        };
      } catch {
        throw new Error("Scope's saved Keychain entry has an invalid format.");
      }
    },
    write: async (secrets) => {
      try {
        if (
          secrets.apiKey ||
          Object.keys(secrets.guestPairs ?? {}).length ||
          Object.keys(secrets.remoteTokens ?? {}).length
        )
          await entry.setPassword(JSON.stringify(decode(Secrets, secrets)));
        else await entry.deleteCredential();
      } catch (cause) {
        throw new Error("Could not update Scope credentials in macOS Keychain.", { cause });
      }
    },
  };
}
