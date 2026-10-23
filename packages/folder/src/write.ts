import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addAbortSignal, type Readable } from "node:stream";
import type { FolderWriteReceipt } from "@irudd-scope/protocol/folder";
import { FolderError, gitName, openInside, validRelative, verifyHandle } from "./paths.ts";

/** A copy in progress has this name until it is committed. */
export const STAGED_PREFIX = ".scope-partial-";

const escaped = () => new FolderError("outside-folder", "Use a path inside the folder.");
const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "";

/** An opened folder inside the root, and the path that addresses its children. */
type Directory = { handle: FileHandle; real: string; base: string };

/**
 * On Linux `/proc/self/fd/N` names the opened folder itself, so files are created and
 * renamed in that folder even if its path is swapped for a link. Elsewhere the verified
 * real path is used and checked again around each step.
 */
function directory(handle: FileHandle, real: string): Directory {
  return {
    handle,
    real,
    base: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : real,
  };
}

async function actualPath(handle: FileHandle, path: string) {
  if (process.platform === "linux") {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (actual !== undefined) return actual;
  }
  return realpath(path);
}

async function openChild(root: string, parent: Directory, part: string, shown: string) {
  const path = join(parent.base, part);
  await mkdir(path).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  let child: FileHandle;
  try {
    child = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") throw new FolderError("not-found", `${shown} does not exist.`);
    if (["ENOTDIR", "ELOOP", "EMLINK"].includes(code)) {
      // macOS reports a link opened as a folder without following it as ENOTDIR.
      const link = await lstat(path).then(
        (entry) => entry.isSymbolicLink(),
        () => false,
      );
      throw link || code !== "ENOTDIR"
        ? new FolderError("outside-folder", `${shown} is a link. Scope does not copy into links.`)
        : new FolderError("not-a-directory", `${shown} is a file, not a folder.`);
    }
    throw error;
  }
  try {
    const real = await actualPath(child, path);
    if (dirname(real) !== parent.real || gitName(real.slice(parent.real.length + 1)))
      throw escaped();
    if (!(await child.stat()).isDirectory())
      throw new FolderError("not-a-directory", `${shown} is a file, not a folder.`);
    await verifyHandle(root, real, child);
    return directory(child, real);
  } catch (error) {
    await child.close().catch(() => {});
    throw error;
  }
}

/**
 * Opens the folder at `parts` below the root, creating missing folders one at a time. Each
 * folder is opened without following a link and checked to be the child of the one before,
 * so a folder swapped for a link, including one into `.git`, is refused.
 */
async function openDestination(
  root: string,
  top: Directory,
  parts: readonly string[],
): Promise<Directory> {
  let current = top;
  try {
    for (const [index, part] of parts.entries()) {
      const child = await openChild(root, current, part, parts.slice(0, index + 1).join("/"));
      if (current !== top) await current.handle.close();
      current = child;
    }
    return current;
  } catch (error) {
    if (current !== top) await current.handle.close().catch(() => {});
    throw error;
  }
}

async function openRoot(root: string) {
  const { handle, real } = await openInside(root, "", { directory: true });
  return directory(handle, real);
}

/** Creates a folder inside the root, as when a dropped folder contains an empty folder. */
export async function createFolderDirectory(root: string, relative: string): Promise<void> {
  const path = validRelative(relative);
  if (!path) return;
  const top = await openRoot(root);
  try {
    const created = await openDestination(root, top, path.split("/"));
    if (created !== top) await created.handle.close();
  } finally {
    await top.handle.close();
  }
}

/**
 * Copies bytes into the folder. They are staged in a new file at the top of the folder,
 * where a cancelled or failed copy can always remove it, and renamed into the destination
 * only after every folder on the way is checked again. A destination on another file
 * system stages in the destination itself. Without `replace` an existing entry fails with
 * `exists`, including one created while the bytes were copied; a hard link makes that check
 * and the commit one step where the file system supports it. Missing folders are created.
 */
export async function writeFolderFile(
  root: string,
  relative: string,
  body: Readable,
  options: { replace: boolean; signal: AbortSignal },
): Promise<FolderWriteReceipt> {
  const path = validRelative(relative);
  if (!path) throw new FolderError("not-a-directory", "Choose a file name inside the folder.");
  const parts = path.split("/");
  const fileName = parts.pop()!;
  options.signal.throwIfAborted();
  const top = await openRoot(root);
  let destination: Directory | undefined;
  let file: FileHandle | undefined;
  let stagedPath: string | undefined;
  try {
    destination = await openDestination(root, top, parts);
    const [topInfo, destinationInfo] = await Promise.all([
      top.handle.stat(),
      destination.handle.stat(),
    ]);
    const stage = topInfo.dev === destinationInfo.dev ? top : destination;
    const staged = `${STAGED_PREFIX}${randomUUID()}`;
    stagedPath = join(stage.base, staged);
    file = await open(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o666,
    );
    const opened = await file.stat();
    const check = async () => {
      await verifyHandle(root, stage.real, stage.handle);
      await verifyHandle(root, destination!.real, destination!.handle);
      if (process.platform !== "linux") {
        const entry = await lstat(join(stage.real, staged));
        if (entry.ino !== opened.ino || entry.dev !== opened.dev) throw escaped();
      }
    };
    await check();
    let size = 0;
    for await (const chunk of addAbortSignal(options.signal, body) as AsyncIterable<Buffer>) {
      await file.write(chunk);
      size += chunk.byteLength;
    }
    options.signal.throwIfAborted();
    await file.sync();
    await file.close();
    file = undefined;
    await check();
    const finalPath = join(destination.base, fileName);
    if (options.replace) {
      const existing = await lstat(finalPath).catch(() => undefined);
      if (existing?.isDirectory())
        throw new FolderError("not-a-directory", `${path} is a folder and cannot be replaced.`);
      await rename(stagedPath, finalPath);
    } else {
      try {
        await link(stagedPath, finalPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") throw clash(path);
        // File systems without hard links, such as FAT, check and rename instead.
        if (
          await lstat(finalPath).then(
            () => true,
            () => false,
          )
        )
          throw clash(path);
        await rename(stagedPath, finalPath);
      }
    }
    return { path, size };
  } finally {
    await file?.close().catch(() => {});
    // After a hard link the staged name is left over; after a rename it is already gone.
    if (stagedPath) await unlink(stagedPath).catch(() => {});
    if (destination && destination !== top) await destination.handle.close().catch(() => {});
    await top.handle.close().catch(() => {});
  }
}

function clash(path: string) {
  return new FolderError("exists", `${path} already exists.`);
}
