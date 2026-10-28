import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** Opens without following a final symbolic link and without waiting on a FIFO. */
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

export async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isDirectory() ?? false;
}

export async function isRegularFile(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isFile() ?? false;
}

export type SmallRead =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "text"; text: string };

/** Opens a regular file without following a final link; anything else gives null. */
async function openRegular(path: string): Promise<{ handle: FileHandle; size: number } | null> {
  if (!(await isRegularFile(path))) return null;
  const handle = await open(path, readFlags).catch(() => null);
  if (!handle) return null;
  const info = await handle.stat().catch(() => null);
  if (info?.isFile()) return { handle, size: info.size };
  await handle.close().catch(() => {});
  return null;
}

/**
 * Reads a regular file up to `limit` bytes. Links, other file types, larger files and read
 * errors are unreadable, so a caller never parses a partial document.
 */
export async function readSmallFile(path: string, limit: number): Promise<SmallRead> {
  if (!(await lstatOrNull(path))) return { kind: "missing" };
  const opened = await openRegular(path);
  if (!opened) return { kind: "unreadable" };
  try {
    if (opened.size > limit) return { kind: "unreadable" };
    const bytes = await opened.handle.readFile();
    return bytes.length > limit
      ? { kind: "unreadable" }
      : { kind: "text", text: bytes.toString("utf8") };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Parses JSON without letting a parse error escape. V8 error messages quote part of the
 * input, and these files hold tokens.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Fingerprint = { bytes: number; lines: number; sha256: string };

/** Hashes a regular file and counts its lines while streaming, without following a link. */
export async function fingerprintFile(path: string): Promise<Fingerprint | null> {
  const opened = await openRegular(path);
  if (!opened) return null;
  const hash = createHash("sha256");
  let bytes = 0;
  let newlines = 0;
  let last = 10;
  try {
    for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
      const view = chunk as Buffer;
      hash.update(view);
      for (const byte of view) if (byte === 10) newlines += 1;
      bytes += view.length;
      last = view.at(-1) ?? last;
    }
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => {});
  }
  return { bytes, lines: newlines + (last === 10 ? 0 : 1), sha256: hash.digest("hex") };
}

export type FolderEntry = { name: string; kind: "directory" | "file" | "link" | "other" };

/** Lists a real directory's entries without following links. A linked folder lists nothing. */
export async function listFolder(path: string): Promise<FolderEntry[] | null> {
  if (!(await isRealDirectory(path))) return null;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => ({ name: entry.name, kind: await entryKind(path, entry) })),
    );
    return listed.sort((left, right) => compareNames(left.name, right.name));
  } catch {
    return null;
  }
}

/** Some file systems report no type in a listing; `lstat` then tells without following. */
async function entryKind(folder: string, entry: Dirent): Promise<FolderEntry["kind"]> {
  const known = kindOf(entry);
  if (known !== "other") return known;
  const info = await lstatOrNull(join(folder, entry.name));
  return info ? kindOf(info) : "other";
}

function kindOf(entry: Dirent | Stats): FolderEntry["kind"] {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "directory";
  return entry.isFile() ? "file" : "other";
}

export function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
