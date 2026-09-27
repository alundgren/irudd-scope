import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { startArtifactServer } from "./server.ts";

export async function startLocalArtifacts(options: {
  directory: string;
  connectionFile: string;
  port?: number;
}) {
  let token: string;
  try {
    token = decodeLocalConnection(JSON.parse(await readFile(options.connectionFile, "utf8"))).token;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error(
        "Cannot read the local Scope connection file. Check its path, permissions, and contents.",
      );
    token = randomBytes(32).toString("base64url");
  }
  const server = await startArtifactServer({ ...options, token });
  const temporary = `${options.connectionFile}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(options.connectionFile), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ version: 1, endpoint: server.url, token }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, options.connectionFile);
  } catch (error) {
    await server.close();
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { ...server, token };
}
