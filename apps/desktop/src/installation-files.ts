import { randomUUID } from "node:crypto";
import { access, lstat, readFile, readlink, readdir, rename, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";

const Installation = Schema.Struct({
  root: Schema.String,
  vp: Schema.String,
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
});
export type Installation = typeof Installation.Type;

export async function readInstallation(appDirectory: string): Promise<Installation> {
  const manifest = JSON.parse(await readFile(join(appDirectory, "package.json"), "utf8"));
  const installation = decode(Installation, manifest.scopeInstallation);
  if (!isAbsolute(installation.root) || !isAbsolute(installation.vp))
    throw new Error("Scope's installation paths are invalid. Run the installer again.");
  return installation;
}

export async function pointToBuild(
  root: string,
  name: "current" | "previous" | "prepared",
  build: string,
) {
  if (dirname(build) !== join(root, "builds") || !/^[0-9a-f]{40}$/.test(build.split("/").at(-1)!))
    throw new Error("The prepared app is outside Scope's build directory.");
  const target = join(root, name);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing && !existing.isSymbolicLink())
    throw new Error(`${target} is not a Scope installation link. Move it aside and retry.`);
  const temporary = join(root, `.${name}-${randomUUID()}`);
  try {
    await symlink(build, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function activateBuild(root: string, build: string) {
  await access(join(build, "Scope.app/Contents/MacOS/Scope"), constants.X_OK);
  const previous = await readlink(join(root, "current")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (previous && previous !== build) await pointToBuild(root, "previous", previous);
  await pointToBuild(root, "current", build);
}

export async function pruneBuilds(installation: Installation) {
  if (
    await access(join(installation.root, ".install-lock")).then(
      () => true,
      () => false,
    )
  )
    return;
  const keep = new Set([join(installation.root, "builds", installation.commit)]);
  for (const name of ["current", "previous", "prepared"]) {
    const target = await readlink(join(installation.root, name)).catch(() => undefined);
    if (target) keep.add(resolve(installation.root, target));
  }
  const builds = join(installation.root, "builds");
  for (const entry of await readdir(builds, { withFileTypes: true })) {
    const directory = join(builds, entry.name);
    if (entry.isDirectory() && /^[0-9a-f]{40}$/.test(entry.name) && !keep.has(directory))
      await rm(directory, { recursive: true });
  }
}
