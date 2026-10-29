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

/**
 * The path of `names` below `home`, or null when a folder between home and the last name is
 * missing, a link or not a directory. Every read starts here, so a linked parent such as a
 * `~/.codex/skills` link is never followed.
 */
export async function belowHome(home: string, names: readonly string[]): Promise<string | null> {
  let path = home;
  for (const name of names.slice(0, -1)) {
    path = join(path, name);
    if (!(await lstatOrNull(path))?.isDirectory()) return null;
  }
  return join(home, ...names);
}

/** The entry itself, without following it, when its parent folders are real directories. */
export async function entryBelowHome(home: string, names: readonly string[]) {
  const path = await belowHome(home, names);
  const info = path ? await lstatOrNull(path) : null;
  return path && info ? { path, info } : null;
}

export async function isRealDirectory(home: string, names: readonly string[]): Promise<boolean> {
  return (await entryBelowHome(home, names))?.info.isDirectory() ?? false;
}

export async function isRegularFile(home: string, names: readonly string[]): Promise<boolean> {
  return (await entryBelowHome(home, names))?.info.isFile() ?? false;
}

export type SmallRead =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "text"; text: string };

/** Opens a regular file without following a link; anything else gives null. */
async function openRegular(
  home: string,
  names: readonly string[],
): Promise<{ handle: FileHandle; size: number } | null> {
  const entry = await entryBelowHome(home, names);
  if (!entry?.info.isFile()) return null;
  const handle = await open(entry.path, readFlags).catch(() => null);
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
export async function readSmallFile(
  home: string,
  names: readonly string[],
  limit: number,
): Promise<SmallRead> {
  if (!(await entryBelowHome(home, names))) return { kind: "missing" };
  const opened = await openRegular(home, names);
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

export type TextRead =
  | {
      kind: "missing" | "linked-folder" | "linked" | "not-file" | "too-large" | "not-text";
    }
  | { kind: "unreadable" }
  | { kind: "text"; bytes: Buffer; text: string };

/**
 * Reads a regular file below home as UTF-8 text. A linked folder on the way, a linked or
 * other final entry, and a file over `limit` bytes are refused without reading any content.
 */
export async function readTextFile(
  home: string,
  names: readonly string[],
  limit: number,
): Promise<TextRead> {
  const path = await belowHome(home, names);
  if (!path) return { kind: (await missingFolder(home, names)) ? "missing" : "linked-folder" };
  const info = await lstatOrNull(path);
  if (!info) return { kind: "missing" };
  if (info.isSymbolicLink()) return { kind: "linked" };
  if (!info.isFile()) return { kind: "not-file" };
  const opened = await openRegular(home, names);
  if (!opened) return { kind: "not-file" };
  try {
    return opened.size > limit ? { kind: "too-large" } : await readText(opened.handle, limit);
  } catch {
    return { kind: "unreadable" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** A file can grow after its size was checked, so reading stops one byte past the limit. */
async function readText(handle: FileHandle, limit: number): Promise<TextRead> {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    length += bytesRead;
    if (bytesRead === 0 || length === buffer.length) break;
  }
  if (length > limit) return { kind: "too-large" };
  const bytes = buffer.subarray(0, length);
  try {
    return { kind: "text", bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "not-text" };
  }
}

/** True when a folder on the way is missing; false when one is a link or another entry. */
async function missingFolder(home: string, names: readonly string[]): Promise<boolean> {
  let path = home;
  for (const name of names.slice(0, -1)) {
    path = join(path, name);
    const info = await lstatOrNull(path);
    if (!info) return true;
    if (!info.isDirectory()) return false;
  }
  return false;
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
export async function fingerprintFile(
  home: string,
  names: readonly string[],
): Promise<Fingerprint | null> {
  const opened = await openRegular(home, names);
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
export async function listFolder(
  home: string,
  names: readonly string[],
): Promise<FolderEntry[] | null> {
  const path = await belowHome(home, names);
  if (!path || !(await isRealDirectory(home, names))) return null;
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
