import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";

const SigningIdentity = Schema.String.check(Schema.isPattern(/^[0-9A-F]{40}$/));
const buildName = /^[0-9a-f]{40}(?:-[0-9A-F]{40})?$/;
const Installation = Schema.Struct({
  root: Schema.String,
  vp: Schema.String,
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  signingIdentity: Schema.optionalKey(SigningIdentity),
});
export type Installation = typeof Installation.Type;

export async function readInstallation(appDirectory: string): Promise<Installation> {
  const manifest = JSON.parse(await readFile(join(appDirectory, "package.json"), "utf8"));
  const installation = decode(Installation, manifest.scopeInstallation);
  if (!isAbsolute(installation.root) || !isAbsolute(installation.vp))
    throw new Error("Scope's installation paths are invalid. Run the installer again.");
  return installation;
}

export async function readSigningIdentity(
  root: string,
  requested?: string,
): Promise<string | undefined> {
  if (requested === undefined) {
    const current = await readInstallation(
      join(root, "current/Scope.app/Contents/Resources/app"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (current && current.root !== root)
      throw new Error("The current app belongs to another installation directory.");
    return current?.signingIdentity;
  }
  if (requested === "-") return undefined;
  try {
    return decode(SigningIdentity, requested.trim().toUpperCase());
  } catch {
    throw new Error(
      "SCOPE_SIGNING_IDENTITY must be a 40-character certificate fingerprint or '-' for ad-hoc signing.",
    );
  }
}

export function installationBuildDirectory(installation: Installation) {
  const suffix = installation.signingIdentity ? `-${installation.signingIdentity}` : "";
  return join(installation.root, "builds", `${installation.commit}${suffix}`);
}

export async function pointToBuild(
  root: string,
  name: "current" | "previous" | "prepared",
  build: string,
) {
  validateBuild(root, build);
  await pointToInstallationPath(root, name, build);
}

function validateBuild(root: string, build: string) {
  if (dirname(build) !== join(root, "builds") || !buildName.test(basename(build)))
    throw new Error("The prepared app is outside Scope's build directory.");
}

async function readInstallationLink(root: string, name: string) {
  const target = join(root, name);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing && !existing.isSymbolicLink())
    throw new Error(`${target} is not a Scope installation link. Move it aside and retry.`);
  return existing ? readlink(target) : undefined;
}

async function pointToInstallationPath(root: string, name: string, path: string | undefined) {
  await readInstallationLink(root, name);
  const target = join(root, name);
  if (path === undefined) {
    await rm(target, { force: true });
    return;
  }
  const temporary = join(root, `.${name}-${randomUUID()}`);
  try {
    await symlink(path, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function activateBuild(root: string, build: string, application?: string) {
  validateBuild(root, build);
  const bundle = join(build, "Scope.app");
  await access(join(bundle, "Contents/MacOS/Scope"), constants.X_OK);
  const metadata = await readInstallation(join(bundle, "Contents/Resources/app"));
  if (metadata.root !== root || installationBuildDirectory(metadata) !== build)
    throw new Error(
      "The prepared update has a different commit, signing identity, or installation directory.",
    );

  const lock = join(root, ".activation-lock");
  await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new Error("Another Scope activation may be running. Wait for it to finish and retry.");
    throw error;
  });
  let staging: string | undefined;
  let cleanup = true;
  try {
    const current = await readInstallationLink(root, "current");
    const previous = await readInstallationLink(root, "previous");
    const recordedApplication = await readInstallationLink(root, "application");
    application ??= recordedApplication ?? join(homedir(), "Applications/Scope.app");
    if (!isAbsolute(application)) throw new Error("Scope's application path must be absolute.");
    await mkdir(dirname(application), { recursive: true });
    const parent = await realpath(dirname(application));
    const installationRoot = await realpath(root);
    if (parent === installationRoot || parent.startsWith(`${installationRoot}${sep}`))
      throw new Error("Install Scope.app outside its build and installation directories.");
    const existing = await lstat(application).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const managed =
      !existing ||
      (existing.isSymbolicLink()
        ? (await readlink(application)) === join(root, "current/Scope.app")
        : existing.isDirectory() &&
          (await readInstallation(join(application, "Contents/Resources/app")).then(
            (value) => value.root === root,
            () => false,
          )));
    if (!managed)
      throw new Error(
        `${application} already exists and is not managed by this installer. Move it aside and retry.`,
      );

    staging = await mkdtemp(join(parent, ".scope-install-"));
    const replacement = join(staging, "Scope.app");
    const backup = join(staging, "previous.app");
    // Electron frameworks use relative links that must remain inside the copied bundle.
    await cp(bundle, replacement, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const changedLinks: [string, string | undefined][] = [];
    let moved = false;
    let installed = false;
    cleanup = false;
    try {
      if (existing) {
        await rename(application, backup);
        moved = true;
      }
      await rename(replacement, application);
      installed = true;
      const links: [string, string | undefined, string][] = [
        ["current", current, build],
        ["application", recordedApplication, application],
      ];
      if (current && current !== build) links.unshift(["previous", previous, current]);
      for (const [name, before, after] of links) {
        await pointToInstallationPath(root, name, after);
        changedLinks.push([name, before]);
      }
      cleanup = true;
    } catch (error) {
      try {
        for (const [name, before] of changedLinks.reverse())
          await pointToInstallationPath(root, name, before);
        if (installed) await rm(application, { recursive: true, force: true });
        if (moved) await rename(backup, application);
        cleanup = true;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Could not restore Scope. Its previous app is at ${backup}.`,
        );
      }
      throw error;
    }
    if (process.platform === "darwin")
      await promisify(execFile)("/usr/bin/mdimport", [application], { timeout: 10_000 }).catch(
        () => {
          console.error("Scope was installed, but Spotlight could not refresh its index yet.");
        },
      );
    return application;
  } finally {
    try {
      if (staging && cleanup)
        await rm(staging, { recursive: true, force: true }).catch(() => {
          console.error(`Could not remove the temporary installation directory ${staging}.`);
        });
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

export async function pruneBuilds(installation: Installation) {
  for (const name of [".install-lock", ".activation-lock"])
    if (
      await access(join(installation.root, name)).then(
        () => true,
        () => false,
      )
    )
      return;
  const keep = new Set([installationBuildDirectory(installation)]);
  for (const name of ["current", "previous", "prepared"]) {
    const target = await readlink(join(installation.root, name)).catch(() => undefined);
    if (target) keep.add(resolve(installation.root, target));
  }
  const builds = join(installation.root, "builds");
  for (const entry of await readdir(builds, { withFileTypes: true })) {
    const directory = join(builds, entry.name);
    if (entry.isDirectory() && buildName.test(entry.name) && !keep.has(directory))
      await rm(directory, { recursive: true });
  }
}
