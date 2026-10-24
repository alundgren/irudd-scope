import { constants } from "node:fs";
import { lstat, open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { decode } from "@irudd-scope/protocol";
import { FolderRelativePath, type FolderErrorCode } from "@irudd-scope/protocol/folder";

/** `.git` is never shown, listed, or watched. */
export const GIT_DIRECTORY = ".git";
const GIT_REFUSED = "Scope does not show .git.";

const STATUS: Record<FolderErrorCode, number> = {
  "no-tab": 404,
  "not-found": 404,
  "outside-folder": 403,
  "not-a-directory": 400,
  unsupported: 501,
  "desktop-offline": 503,
  exists: 409,
  failed: 500,
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
  // `.git` itself, a folder inside it, or a link to either is never opened as a folder.
  if (gitPath(real)) throw new FolderError("not-found", GIT_REFUSED);
  const info = await stat(real);
  if (!info.isDirectory()) throw new FolderError("not-a-directory", `${path} is not a folder.`);
  // The native real path already gives Windows aliases such as `GIT~1` or `.git.` their own
  // name; the identity check also covers any other name for the parent's `.git`.
  const git = await lstat(join(dirname(real), GIT_DIRECTORY)).catch(() => undefined);
  if (dirname(real) !== real && git?.dev === info.dev && git.ino === info.ino)
    throw new FolderError("not-found", GIT_REFUSED);
  return real;
}

/** Whether an absolute path, with either separator, passes through `.git` in any letter case. */
export function gitPath(path: string): boolean {
  return path.split(/[\\/]/).some(gitName);
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
  let path: string;
  try {
    path = decode(FolderRelativePath, relative);
  } catch {
    throw new FolderError("outside-folder", "Use a path inside the folder.");
  }
  // Letter case matters only on some file systems: `.GIT` is `.git` on macOS and Windows.
  if (path.split("/").some(gitName)) throw new FolderError("not-found", GIT_REFUSED);
  return path;
}

export function gitName(name: string): boolean {
  return name.toLowerCase() === GIT_DIRECTORY;
}

/**
 * Whether two names or paths reach the same entry by letter case: macOS and Windows volumes
 * usually ignore it, Linux volumes do not. Use it where a name must match what the file
 * system resolves, such as `.GITIGNORE` read as `.gitignore`.
 */
export function sameSpelling(a: string, b: string): boolean {
  return process.platform === "darwin" || process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** A copy in progress has this name until it is committed. */
export const STAGED_PREFIX = ".scope-partial-";

/** Names never shown, listed, searched, or reported as changes: `.git` and staged copies. */
export function hiddenName(name: string): boolean {
  return gitName(name) || name.startsWith(STAGED_PREFIX);
}

/** Whether a real path inside the root passes through `.git`, for example through a link. */
export function insideGit(root: string, real: string): boolean {
  return real.slice(root.length).split(sep).some(gitName);
}

/** The path inside the root, without following a final symlink. */
export function joinInside(root: string, relative: string): string {
  const path = validRelative(relative);
  return path ? join(root, ...path.split("/")) : root;
}

/** Resolves an absolute path below a canonical root to its real path, which must stay inside. */
async function resolveJoined(root: string, path: string, shown: string): Promise<string> {
  await checkRoot(root);
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    if (missing(error)) throw new FolderError("not-found", `${shown} does not exist.`);
    throw error;
  }
  if (!inside(root, real)) throw new FolderError("outside-folder", "Use a path inside the folder.");
  return real;
}

/**
 * Resolves a path inside a canonical root and returns its real path. Symlinks are
 * followed only while they stay inside the root.
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const real = await resolveJoined(root, joinInside(root, relative), relative);
  if (insideGit(root, real)) throw new FolderError("not-found", GIT_REFUSED);
  return real;
}

const escaped = () => new FolderError("outside-folder", "Use a path inside the folder.");

/**
 * Checks that an opened file or directory is the one at `real` inside the root. Linux asks
 * the kernel for the handle's path. Elsewhere every folder between the root and `real` must
 * still be a real directory and the entry must be the opened one, so a folder swapped for a
 * symlink while the handle was opened is rejected.
 */
export async function verifyHandle(root: string, real: string, handle: FileHandle): Promise<void> {
  if (process.platform === "linux") {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (actual !== undefined) {
      if (actual !== real || !inside(root, actual)) throw escaped();
      return;
    }
  }
  const opened = await handle.stat();
  const parts = real.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!(await lstat(current)).isDirectory()) throw escaped();
  }
  const entry = await lstat(real);
  if (entry.isSymbolicLink() || entry.ino !== opened.ino || entry.dev !== opened.dev)
    throw escaped();
  if ((await realpath(real)) !== real) throw escaped();
}

/**
 * Whether reaching `real` through `path` involves a link. A case-insensitive volume resolves
 * `.gitignore` to a file stored as `.GITIGNORE`, so a real path that differs only in letter
 * case is accepted when every part of `path` is itself a real entry. The platform does not
 * say whether a volume ignores case, so each part is checked rather than assumed.
 */
async function linkOnPath(root: string, path: string, real: string): Promise<boolean> {
  if (real.toLowerCase() !== path.toLowerCase()) return true;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Opens a file or directory inside the root without letting a swapped symlink widen it.
 * `nonBlocking` returns at once for a FIFO instead of waiting for a writer; callers that
 * walk the folder use it and then check that the handle is a regular file. `noSymlinks`
 * refuses a symlink anywhere below the root, so a walked folder swapped for a link, even
 * one into `.git` or an ignored folder, is never entered.
 */
export async function openInside(
  root: string,
  relative: string,
  options: {
    directory?: boolean;
    internal?: boolean;
    nonBlocking?: boolean;
    noSymlinks?: boolean;
  } = {},
): Promise<{ handle: FileHandle; real: string }> {
  const path = options.internal ? join(root, ...relative.split("/")) : joinInside(root, relative);
  const real = await resolveJoined(root, path, relative);
  if (options.noSymlinks && real !== path && (await linkOnPath(root, path, real))) throw escaped();
  // A link inside the folder, such as docs/config -> ../.git/config, does not reach `.git`.
  if (!options.internal && insideGit(root, real)) throw new FolderError("not-found", GIT_REFUSED);
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (options.directory ? (constants.O_DIRECTORY ?? 0) : 0) |
    (options.nonBlocking ? (constants.O_NONBLOCK ?? 0) : 0);
  let handle: FileHandle;
  try {
    handle = await open(real, flags);
  } catch (error) {
    if (missing(error)) throw new FolderError("not-found", `${relative} does not exist.`);
    if (error instanceof Error && "code" in error && error.code === "ENOTDIR")
      throw new FolderError("not-a-directory", `${relative} is not a folder.`);
    throw error;
  }
  try {
    await verifyHandle(root, real, handle);
    return { handle, real };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Reads a small regular file, such as `.gitignore` or `.git/info/exclude`, only when every
 * part of its path below the root is a real directory or file, never a link. A FIFO or other
 * special file is opened without waiting for a writer and then skipped.
 */
export async function readInsideText(
  root: string,
  relative: string,
  limit = 1024 * 1024,
): Promise<string | undefined> {
  try {
    const { handle } = await openInside(root, relative, {
      internal: true,
      nonBlocking: true,
      noSymlinks: true,
    });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) return undefined;
      return (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
