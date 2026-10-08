import { execFile } from "node:child_process";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function selectedBuilds(root: string, builds: string) {
  const keep = new Set<string>();
  for (const name of ["current", "previous", "prepared"]) {
    const link = join(root, name);
    const entry = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" || name === "current") throw error;
    });
    if (!entry) continue;
    if (!entry.isSymbolicLink()) throw new Error("The installation path is not a link.");
    const target = await realpath(link);
    if (dirname(target) !== builds || !(await lstat(target)).isDirectory())
      throw new Error("The installation link does not select a build directory.");
    keep.add(target);
  }
  return keep;
}

export async function pruneInstallationBuilds(root: string) {
  try {
    const builds = join(root, "builds");
    if (!(await lstat(builds)).isDirectory()) return;
    const canonicalBuilds = await realpath(builds);
    const keep = await selectedBuilds(root, canonicalBuilds);
    // Launchers use absolute build paths, including the runtime used by their children.
    const { stdout } = await exec("ps", ["-axww", "-o", "pid=", "-o", "command="], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const processes = stdout.trim().split("\n");
    if (processes.some((line) => !/^\s*\d+\s+\S/.test(line))) return;
    const entries = await readdir(builds, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(builds, entry.name);
      const canonical = join(canonicalBuilds, entry.name);
      if (
        keep.has(canonical) ||
        processes.some((line) => line.includes(`${directory}/`) || line.includes(`${canonical}/`))
      )
        continue;
      // Leave links and other files alone even if an entry changed during inspection.
      if ((await lstat(directory)).isDirectory()) await rm(directory, { recursive: true });
    }
  } catch {
    // Cleanup is optional. Unreadable links or processes must never cost a usable build.
  }
}
