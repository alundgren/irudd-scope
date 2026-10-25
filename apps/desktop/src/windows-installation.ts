import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, win32 } from "node:path";
import {
  installationAppDirectory,
  installationBuildDirectory,
  pointToInstallationPath,
  readInstallation,
  readInstallationLink,
  sameInstallationPath,
  validateBuild,
} from "./installation-files.ts";
import { runInstallationCommand, windowsPowerShell } from "./installation-process.ts";

export const WINDOWS_APP_ID = "alundgren.irudd-scope";

export async function isWindowsLauncher(path: string, kind: "desktop" | "CLI") {
  return readFile(path).then(
    (bytes) => bytes.includes(Buffer.from(`Scope native ${kind} launcher v1`)),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
}

export async function integrateWindows(root: string, build: string) {
  const backup = await mkdtemp(join(root, ".integration-"));
  let cleanup = true;
  const run = (action: "apply" | "restore") =>
    runInstallationCommand(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(installationAppDirectory(build, "win32"), "windows-integration.ps1"),
        "-Root",
        root,
        "-Backup",
        backup,
        "-Action",
        action,
      ],
      { cwd: root, signal: AbortSignal.timeout(60_000) },
    );
  try {
    await run("apply");
  } catch (error) {
    try {
      await run("restore");
    } catch (restoreError) {
      cleanup = false;
      throw new AggregateError(
        [error, restoreError],
        `Could not restore Scope's shortcut. Backups remain at ${backup}.`,
      );
    }
    throw error;
  } finally {
    if (cleanup)
      await rm(backup, { recursive: true, force: true }).catch(() => {
        console.error("Could not remove the temporary Windows registration backup.");
      });
  }
}

export async function activateWindowsBuild(
  root: string,
  build: string,
  integrate = integrateWindows,
) {
  validateBuild(root, build);
  const app = installationAppDirectory(build, "win32");
  await access(join(build, "Scope/Scope.exe"));
  const metadata = await readInstallation(app);
  if (
    metadata.platform !== "win32" ||
    !sameInstallationPath(metadata.root, root) ||
    !sameInstallationPath(installationBuildDirectory(metadata), build)
  )
    throw new Error(
      "The prepared Windows update has a different commit or installation directory.",
    );
  const lock = join(root, ".activation-lock");
  await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new Error("Another Scope activation may be running. Wait for it to finish and retry.");
    throw error;
  });
  const changed: [string, string | undefined][] = [];
  const launcher = join(root, "Scope.exe");
  let installedLauncher = false;
  try {
    const current = await readInstallationLink(root, "current");
    const previous = await readInstallationLink(root, "previous");
    try {
      await copyFile(join(app, "bin/Scope.exe"), launcher, constants.COPYFILE_EXCL);
      installedLauncher = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await isWindowsLauncher(launcher, "desktop")))
        throw new Error(
          `${launcher} already exists and is not Scope's launcher. Move it aside and retry.`,
        );
    }
    const links: [string, string | undefined, string][] = [];
    if (current && current !== build) links.push(["previous", previous, current]);
    links.push(["current", current, build]);
    for (const [name, before, after] of links) {
      await pointToInstallationPath(root, name, after, "win32");
      changed.push([name, before]);
    }
    // Registration restores its snapshot even when its PowerShell process is interrupted.
    await integrate(root, build);
    return join(build, "Scope");
  } catch (error) {
    const restoreErrors: unknown[] = [];
    for (const [name, before] of changed.reverse()) {
      try {
        await pointToInstallationPath(root, name, before, "win32");
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (installedLauncher) {
      try {
        await rm(launcher);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length)
      throw new AggregateError(
        [error, ...restoreErrors],
        "Could not restore every Scope installation reference. Run install.ps1 to repair the installation.",
      );
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function runningWindowsBuilds(root: string) {
  const output = await runInstallationCommand(
    windowsPowerShell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @((Get-CimInstance Win32_Process -Filter \"Name = 'Scope.exe'\").ExecutablePath | Where-Object { $_ })",
    ],
    { cwd: root, signal: AbortSignal.timeout(15_000) },
  );
  const paths: unknown = JSON.parse(output);
  if (!Array.isArray(paths) || !paths.every((value): value is string => typeof value === "string"))
    throw new Error("Could not read running Scope applications.");
  return paths
    .map((path) => win32.dirname(win32.dirname(path)))
    .filter((build) => {
      try {
        validateBuild(root, build, "win32");
        return true;
      } catch {
        return false;
      }
    })
    .map((build) => win32.join(root, "builds", win32.basename(build)));
}
