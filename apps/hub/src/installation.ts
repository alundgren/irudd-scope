import { readFile, rename, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { BuildCommit } from "@irudd-scope/protocol/remote";

const AbsolutePath = Schema.String.check(Schema.makeFilter(isAbsolute));
const Installation = Schema.Struct({
  root: AbsolutePath,
  commit: BuildCommit,
  vp: AbsolutePath,
  bin: AbsolutePath,
});
export type Installation = typeof Installation.Type;
const exec = promisify(execFile);

export class InstalledSkillError extends Error {}

export async function runSkillCommand(installation: Installation, command: "check" | "sync") {
  const root = join(installation.root, "current");
  try {
    const { stdout } = await exec(
      process.execPath,
      [join(root, "cli/main.mjs"), "skill", command],
      {
        env: { ...process.env, SCOPE_CLI_ROOT: root },
        timeout: 5000,
        maxBuffer: 8192,
      },
    );
    const receipt: unknown = JSON.parse(stdout);
    return decode(Schema.Struct({ installed: Schema.Boolean }), receipt).installed;
  } catch (error) {
    const detail =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : "Could not check the installed Scope skill.";
    throw new InstalledSkillError(detail.slice(-8192));
  }
}

export async function readInstallation(build = resolve(import.meta.dirname, "..")) {
  const metadata = JSON.parse(await readFile(join(build, "package.json"), "utf8"));
  return metadata.scopeInstallation ? decode(Installation, metadata.scopeInstallation) : undefined;
}

export async function selectBuild(root: string, name: "current" | "previous", build: string) {
  const temporary = join(root, `.${name}-${randomUUID()}`);
  await symlink(build, temporary);
  await rename(temporary, join(root, name));
}
