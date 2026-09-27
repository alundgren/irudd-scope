import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SigningCertificate } from "./installation-contract.ts";

const exec = promisify(execFile);

export async function openKeychainAccess() {
  if (process.platform !== "darwin") throw new Error("Keychain Access requires macOS.");
  await exec("/usr/bin/open", ["-b", "com.apple.keychainaccess"], { timeout: 10_000 });
}

export async function findSigningCertificate(
  reference: string,
  signal: AbortSignal,
): Promise<SigningCertificate> {
  const { stdout } = await exec("/usr/bin/security", ["find-identity", "-p", "codesigning"], {
    signal,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return selectSigningCertificate(stdout, reference);
}

export function selectSigningCertificate(output: string, reference: string): SigningCertificate {
  const requested = reference.trim();
  if (!requested) throw new Error("Enter the certificate name from Keychain Access.");
  const matches = new Map<string, SigningCertificate>();
  // The command lists matching identities and then lists valid identities again.
  // Self-signed certificates can appear only in the first list.
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\) ([0-9A-Fa-f]{40}) "(.*)"(?: \(.*\))?\s*$/.exec(line);
    if (!match) continue;
    const fingerprint = match[1]!.toUpperCase();
    const name = match[2]!;
    if (name === requested || fingerprint === requested.toUpperCase())
      matches.set(fingerprint, { name, fingerprint });
  }
  if (matches.size > 1)
    throw new Error(
      "More than one code-signing certificate has that name. Paste the certificate's SHA-1 fingerprint from Keychain Access instead.",
    );
  const certificate = matches.values().next().value;
  if (!certificate)
    throw new Error(
      "No code-signing certificate with that name or fingerprint was found. Check the name and keep its private key in your login keychain.",
    );
  return certificate;
}
