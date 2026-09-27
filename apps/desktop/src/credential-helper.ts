import { spawn } from "node:child_process";

export const CREDENTIAL_HELPER_NAME = "Scope Credentials";
const maximumBytes = 1024 * 1024;

export function credentialHelperEntry(executable: string, account: string) {
  async function request(operation: "read" | "write" | "delete", value?: string) {
    const input = JSON.stringify({ operation, account, ...(value === undefined ? {} : { value }) });
    if (Buffer.byteLength(input) > maximumBytes)
      throw new Error("Scope's credentials exceed the helper's size limit.");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { SCOPE_CREDENTIALS_KEYCHAIN: process.env.SCOPE_CREDENTIALS_KEYCHAIN },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const stop = (message: string) => {
        failure ??= new Error(message);
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop("Scope's credential helper timed out."), 120_000);
      child.on("error", () => {
        failure ??= new Error("Could not start Scope's credential helper. Reinstall Scope.");
      });
      child.stdin.on("error", () => stop("Could not send the credential request."));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumBytes) stop("Scope's credential helper returned too much data.");
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Scope's credential helper failed (${code}).`));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.end(input);
    });
    // Never attach process output or parser errors, which can contain saved credentials.
    try {
      const result: unknown = JSON.parse(output);
      if (result === null || typeof result === "string") return result;
    } catch {
      // Report the same error for malformed JSON and an unexpected response type.
    }
    throw new Error("Scope's credential helper returned an invalid response.");
  }
  return {
    getPassword: () => request("read"),
    setPassword: async (value: string) => {
      await request("write", value);
    },
    deleteCredential: async () => {
      await request("delete");
      return true;
    },
  };
}
