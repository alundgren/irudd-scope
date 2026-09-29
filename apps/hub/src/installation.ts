import { readFile, rename, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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

export async function readInstallation(build = resolve(import.meta.dirname, "..")) {
  const metadata = JSON.parse(await readFile(join(build, "package.json"), "utf8"));
  return metadata.scopeInstallation ? decode(Installation, metadata.scopeInstallation) : undefined;
}

export async function selectBuild(root: string, name: "current" | "previous", build: string) {
  const temporary = join(root, `.${name}-${randomUUID()}`);
  await symlink(build, temporary);
  await rename(temporary, join(root, name));
}
