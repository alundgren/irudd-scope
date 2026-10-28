import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { isRegularFile, lstatOrNull } from "./files.ts";

const VERSION_TIMEOUT_MS = 5000;
const versionPattern = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

/** Reads a link's own target. The link is never followed and its target is never opened. */
export async function linkTarget(path: string): Promise<string | null> {
  try {
    return (await lstatOrNull(path))?.isSymbolicLink() ? await readlink(path) : null;
  } catch {
    return null;
  }
}

export function cleanVersion(value: string | undefined): string | null {
  if (!value || value.length > 64 || !/^[0-9][0-9A-Za-z.+-]*$/.test(value)) return null;
  return value;
}

/** Finds the first regular file or link named `name` in PATH, with `.exe` on Windows. */
export async function findOnPath(name: string, path: string): Promise<string | null> {
  const names = process.platform === "win32" ? [`${name}.exe`] : [name];
  for (const folder of path.split(delimiter)) {
    if (!folder) continue;
    for (const candidate of names) {
      const file = join(folder, candidate);
      const info = await lstatOrNull(file);
      if (info && (info.isFile() || info.isSymbolicLink())) return file;
    }
  }
  return null;
}

/**
 * The last resort when no install link names the version: one `--version` call with a short
 * time limit. Only a version number is taken from its output; failures give null.
 */
export function runVersion(binary: string, path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      {
        timeout: VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: versionEnvironment(path),
      },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(cleanVersion(versionPattern.exec(String(stdout))?.[0]));
      },
    );
  });
}

function versionEnvironment(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // Node passes only one spelling of each Windows environment variable.
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  return { ...env, PATH: path };
}

export type VersionSource = {
  /** Reads the version from install links, or returns null when none applies. */
  fromLinks: () => Promise<string | null>;
  binary: string;
  /** Folders searched before PATH for the `--version` fallback. */
  extraPath?: string[];
};

export async function detectVersion(source: VersionSource, path: string): Promise<string | null> {
  const linked = await source.fromLinks();
  if (linked) return linked;
  const searchPath = [...(source.extraPath ?? []), path].filter(Boolean).join(delimiter);
  const binary = await findOnPath(source.binary, searchPath);
  if (!binary) return null;
  if (!(await isRegularFile(binary)) && !(await linkTarget(binary))) return null;
  return runVersion(binary, searchPath);
}

/** The version in a link target's last name, after an optional prefix and before a triple. */
export function versionFromName(target: string | null, prefix = ""): string | null {
  if (!target) return null;
  const name = basename(target.replace(/[\\/]+$/, ""));
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const triple = /^(.+?)-(?:x86_64|aarch64|arm64|armv7|i686|universal)(?:-|$)/.exec(rest);
  return cleanVersion(triple ? triple[1] : rest);
}

/** The folder name after `versions/` in a link target, such as Cursor's install layout. */
export function versionAfterVersionsFolder(target: string | null): string | null {
  if (!target) return null;
  const match = /(?:^|[\\/])versions[\\/]([^\\/]+)(?:[\\/]|$)/.exec(target);
  return cleanVersion(match?.[1]);
}
