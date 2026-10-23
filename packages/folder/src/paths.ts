import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { decode } from "@irudd-scope/protocol";
import { FolderRelativePath, type FolderErrorCode } from "@irudd-scope/protocol/folder";

const STATUS: Record<FolderErrorCode, number> = {
  "no-tab": 404,
  "not-found": 404,
  "outside-folder": 403,
  "not-a-directory": 400,
  unsupported: 501,
  "desktop-offline": 503,
};

/** A folder operation failure with the wire error code and its HTTP status. */
export class FolderError extends Error {
  readonly code: FolderErrorCode;
  readonly status: number;
  constructor(code: FolderErrorCode, message: string) {
    super(message);
    this.name = "FolderError";
    this.code = code;
    this.status = STATUS[code];
  }
}

function missing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))
  );
}

/**
 * The one canonical form of a folder path: the real path with symlinks resolved
 * and the letter case stored on disk. Run it on the machine that has the files.
 */
export async function canonicalFolder(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new FolderError("not-found", "Use an absolute folder path.");
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if (missing(error)) throw new FolderError("not-found", `The folder ${path} does not exist.`);
    throw error;
  }
  if (!(await stat(real)).isDirectory())
    throw new FolderError("not-a-directory", `${path} is not a folder.`);
  return real;
}

/** Checks that a canonical root still exists at the same real path. */
export async function checkRoot(root: string): Promise<void> {
  const current = await canonicalFolder(root).catch((error: unknown) => {
    if (error instanceof FolderError)
      throw new FolderError("not-found", "This folder no longer exists.");
    throw error;
  });
  if (current !== root) throw new FolderError("not-found", "This folder no longer exists.");
}

export function inside(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function validRelative(relative: string): string {
  try {
    return decode(FolderRelativePath, relative);
  } catch {
    throw new FolderError("outside-folder", "Use a path inside the folder.");
  }
}

/** The path inside the root, without following a final symlink. */
export function joinInside(root: string, relative: string): string {
  const path = validRelative(relative);
  return path ? join(root, ...path.split("/")) : root;
}

/**
 * Resolves a path inside a canonical root and returns its real path. Symlinks are
 * followed only while they stay inside the root.
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const path = joinInside(root, relative);
  await checkRoot(root);
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if (missing(error)) throw new FolderError("not-found", `${relative} does not exist.`);
    throw error;
  }
  if (!inside(root, real)) throw new FolderError("outside-folder", "Use a path inside the folder.");
  return real;
}
