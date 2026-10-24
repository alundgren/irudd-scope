import { randomUUID } from "node:crypto";
import {
  close,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  write,
  type Stats,
} from "node:fs";
import { join, sep } from "node:path";
import { addAbortSignal, type Readable } from "node:stream";
import { promisify } from "node:util";
import type { FolderWriteReceipt } from "@irudd-scope/protocol/folder";
import { FolderError, GIT_DIRECTORY, STAGED_PREFIX, openInside, validRelative } from "./paths.ts";

export { STAGED_PREFIX };

const writeChunk = promisify(write);
const syncFile = promisify(fsync);
const closeFile = promisify(close);

const escaped = () => new FolderError("outside-folder", "Use a path inside the folder.");
const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "";

type Identity = { dev: number; ino: number };
/**
 * An opened folder inside the root and the identity of every folder from the root down to it.
 * `git` is the identity of the root's `.git` folder, if it has one.
 */
type Folder = { fd: number; real: string; chain: Identity[]; git?: Identity };

const identity = (info: Stats): Identity => ({ dev: info.dev, ino: info.ino });
const same = (info: Stats | Identity, expected: Identity) =>
  info.dev === expected.dev && info.ino === expected.ino;
function entry(path: string, follow = false) {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Linux names an open folder as `/proc/self/fd/N`, so writes run in the calling process. */
export const procFolders = process.platform === "linux" && existsSync("/proc/self/fd");
/**
 * Set only in the folder writer process. Changing the working directory affects every
 * thread of a process, including file operations already queued by unrelated code, so
 * Electron main and the hub never do it.
 */
let ownWorkingDirectory = false;
export function allowWorkingDirectoryChanges() {
  ownWorkingDirectory = true;
}

/**
 * Runs `step` with names that resolve inside the opened folder itself, never through its
 * path, so a folder on the way swapped for a link cannot redirect it. Linux names the open
 * folder as `/proc/self/fd/N`. Node has no directory-relative calls elsewhere, so there the
 * step runs in the folder writer process (see writer.ts), synchronously, with that
 * process's working directory set to the folder and checked to be the opened one. Its other
 * file work uses absolute paths and descriptors only. Windows resolves relative names from
 * the directory's path, so there the checks before and after each step keep writes inside.
 */
function inFolder<T>(folder: Folder, step: (base: string) => T): T {
  if (procFolders) return step(`/proc/self/fd/${folder.fd}`);
  if (!ownWorkingDirectory)
    throw new Error("Folder writes run in the folder writer process on this platform.");
  const previous = process.cwd();
  try {
    process.chdir(folder.real);
  } catch {
    // The folder's path no longer leads to a folder, as when it was swapped for a link.
    throw escaped();
  }
  try {
    if (!same(statSync("."), folder.chain.at(-1)!)) throw escaped();
    return step(".");
  } finally {
    process.chdir(previous);
  }
}

/**
 * The folder is still inside the root right now: each parent reached through `..`, which
 * follows where the folder really is rather than its path, is the one opened on the way down,
 * and the root is still a real folder at its path.
 */
function stillInside(root: string, folder: Folder, base: string) {
  let path = base;
  for (let index = folder.chain.length - 1; index >= 0; index--) {
    const info = entry(path, true);
    if (!info || !same(info, folder.chain[index]!)) return false;
    path = `${path}/..`;
  }
  const top = entry(root);
  return Boolean(top?.isDirectory() && same(top, folder.chain[0]!));
}

function checkInside(root: string, folder: Folder, base: string) {
  if (!stillInside(root, folder, base)) throw escaped();
}

async function openRoot(root: string): Promise<Folder> {
  const { handle, real } = await openInside(root, "", { directory: true });
  try {
    const info = await handle.stat();
    const fd = openSync(real, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    if (!same(fstatSync(fd), identity(info))) {
      closeSync(fd);
      throw new FolderError("not-found", "This folder no longer exists.");
    }
    const git = entry(join(real, GIT_DIRECTORY));
    return {
      fd,
      real,
      chain: [identity(info)],
      ...(git?.isDirectory() ? { git: identity(git) } : {}),
    };
  } finally {
    await handle.close();
  }
}

function folderError(path: string, shown: string, code: string) {
  // macOS reports a link opened as a folder without following it as ENOTDIR.
  if (entry(path)?.isSymbolicLink() || code === "ELOOP" || code === "EMLINK")
    return new FolderError("outside-folder", `${shown} is a link. Scope does not copy into links.`);
  if (code === "ENOENT") return new FolderError("not-found", `${shown} does not exist.`);
  return new FolderError("not-a-directory", `${shown} is a file, not a folder.`);
}

type Create = "missing" | "exclusive";

/** Windows short names such as `GIT~1` or `REPORT~2.DOC`. */
const SHORT_NAME = /^[^.]{1,6}~\d{1,6}(\.[^.]{0,3})?$/;

/**
 * A path Scope may create. On Windows a name ending in a dot or space, a name with `:`, and a
 * short name can each reach another entry, such as `.git`, so they are refused there.
 */
function writablePath(relative: string): string {
  const path = validRelative(relative);
  if (process.platform !== "win32") return path;
  for (const name of path.split("/"))
    if (/[. ]$/.test(name) || name.includes(":") || SHORT_NAME.test(name))
      throw new FolderError(
        "outside-folder",
        `Windows cannot store ${name} under that exact name. Rename it and try again.`,
      );
  return path;
}

/**
 * Opens the child folder `part` of `parent`, creating it when missing. The parent is checked
 * to be inside the root before and after, and a folder created in a parent that moved out
 * meanwhile is removed again.
 */
function openChild(root: string, parent: Folder, part: string, shown: string, create: Create) {
  return inFolder(parent, (base): Folder => {
    checkInside(root, parent, base);
    const path = `${base}/${part}`;
    let created = false;
    try {
      mkdirSync(path);
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (create === "exclusive") throw new FolderError("exists", `${shown} already exists.`);
    }
    const undo = () => {
      if (created) rmdirSync(path);
    };
    let fd: number;
    try {
      if (entry(path)?.isSymbolicLink()) throw folderError(path, shown, "ELOOP");
      fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
      );
    } catch (error) {
      undo();
      if (error instanceof FolderError) throw error;
      const code = errorCode(error);
      if (["ENOTDIR", "ELOOP", "EMLINK", "ENOENT"].includes(code))
        throw folderError(path, shown, code);
      throw error;
    }
    const info = fstatSync(fd);
    // Windows also opens `.git` as `.git.`, `.git::$INDEX_ALLOCATION`, or its short name.
    if (parent.git && same(info, parent.git)) {
      closeSync(fd);
      throw new FolderError("not-found", "Scope does not show .git.");
    }
    if (!info.isDirectory() || !stillInside(root, parent, base)) {
      closeSync(fd);
      undo();
      if (!info.isDirectory())
        throw new FolderError("not-a-directory", `${shown} is a file, not a folder.`);
      throw escaped();
    }
    return {
      fd,
      real: `${parent.real}${sep}${part}`,
      chain: [...parent.chain, identity(info)],
      ...(parent.git ? { git: parent.git } : {}),
    };
  });
}

/** Opens the folders at `parts` below the root one by one, creating missing ones. */
function openDestination(root: string, top: Folder, parts: readonly string[], last: Create) {
  let current = top;
  try {
    for (const [index, part] of parts.entries()) {
      const create = index === parts.length - 1 ? last : "missing";
      const child = openChild(root, current, part, parts.slice(0, index + 1).join("/"), create);
      if (current !== top) closeSync(current.fd);
      current = child;
    }
    return current;
  } catch (error) {
    if (current !== top) closeSync(current.fd);
    throw error;
  }
}

/**
 * Creates a folder inside the root, as when a dropped folder contains an empty folder.
 * With `exclusive` an existing entry fails with `exists`; otherwise an existing folder is
 * accepted.
 */
export async function createDirectoryInProcess(
  root: string,
  relative: string,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const path = writablePath(relative);
  if (!path) return;
  const top = await openRoot(root);
  try {
    const created = openDestination(
      root,
      top,
      path.split("/"),
      options.exclusive ? "exclusive" : "missing",
    );
    if (created !== top) closeSync(created.fd);
  } finally {
    closeSync(top.fd);
  }
}

/** Renames, or without `replace` hard-links, a staged file to its name in the destination. */
function commit(source: string, target: string, path: string, replace: boolean) {
  if (replace) {
    if (entry(target)?.isDirectory())
      throw new FolderError("not-a-directory", `${path} is a folder and cannot be replaced.`);
    renameSync(source, target);
    return;
  }
  try {
    linkSync(source, target);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") throw new FolderError("exists", `${path} already exists.`);
    if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "EXDEV"].includes(code))
      throw new FolderError(
        "unsupported",
        `The drive under this folder cannot add ${path} without risking an overwrite, so Scope did not copy it.`,
      );
    throw error;
  }
}

/**
 * Copies bytes into the folder. They are staged in a new file at the top of the folder, or
 * in the destination when that is on another file system, so a cancelled or failed copy
 * can always remove them. The commit renames, or without `replace` hard-links, the staged
 * file into the opened destination folder after checking that the copy was not cancelled
 * and that the folder is still inside the root; it checks again afterwards and removes the
 * file if the folder moved out meanwhile. A hard link fails when the name exists, including
 * one created during the copy; a file system without hard links fails with `unsupported`
 * rather than checking and then renaming. Missing folders on the way are created.
 */
export async function writeInProcess(
  root: string,
  relative: string,
  body: Readable,
  options: { replace: boolean; signal: AbortSignal },
): Promise<FolderWriteReceipt> {
  const path = writablePath(relative);
  if (!path) throw new FolderError("not-a-directory", "Choose a file name inside the folder.");
  const parts = path.split("/");
  const fileName = parts.pop()!;
  options.signal.throwIfAborted();
  const top = await openRoot(root);
  let destination: Folder | undefined;
  let stage: Folder | undefined;
  let file: number | undefined;
  let stagedId: Identity | undefined;
  const staged = `${STAGED_PREFIX}${randomUUID()}`;
  try {
    destination = openDestination(root, top, parts, "missing");
    stage = fstatSync(top.fd).dev === fstatSync(destination.fd).dev ? top : destination;
    const stagedIn = stage;
    file = inFolder(stagedIn, (base) => {
      checkInside(root, stagedIn, base);
      return openSync(
        `${base}/${staged}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o666,
      );
    });
    const stagedFile = identity(fstatSync(file));
    stagedId = stagedFile;
    let size = 0;
    for await (const chunk of addAbortSignal(options.signal, body) as AsyncIterable<Buffer>) {
      for (let offset = 0; offset < chunk.byteLength;)
        offset += (await writeChunk(file, chunk, offset, chunk.byteLength - offset)).bytesWritten;
      size += chunk.byteLength;
    }
    await syncFile(file);
    await closeFile(file);
    file = undefined;
    const target = destination;
    inFolder(target, (base) => {
      options.signal.throwIfAborted();
      checkInside(root, target, base);
      // From the top of the folder the staged file is named through the root, whose path
      // Scope trusts; inside the destination, through the same folder reference.
      const source =
        stagedIn === target
          ? `${base}/${staged}`
          : procFolders
            ? `/proc/self/fd/${top.fd}/${staged}`
            : `${top.real}${sep}${staged}`;
      const placed = entry(source);
      if (!placed || !same(placed, stagedFile)) throw escaped();
      commit(source, `${base}/${fileName}`, path, options.replace);
      if (!stillInside(root, target, base)) {
        const committed = entry(`${base}/${fileName}`);
        if (committed && same(committed, stagedFile)) unlinkSync(`${base}/${fileName}`);
        throw escaped();
      }
    });
    return { path, size };
  } finally {
    if (file !== undefined) await closeFile(file).catch(() => {});
    // After a hard link the staged name is left over; after a rename it is already gone.
    if (stage && stagedId) {
      const stagedFile = stagedId;
      try {
        inFolder(stage, (base) => {
          const leftover = entry(`${base}/${staged}`);
          if (leftover && same(leftover, stagedFile)) unlinkSync(`${base}/${staged}`);
        });
      } catch {
        // The top of the folder moved away; nothing staged can be reached through it.
      }
    }
    if (destination && destination !== top) closeSync(destination.fd);
    closeSync(top.fd);
  }
}
