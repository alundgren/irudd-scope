import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { inside } from "./paths.ts";

const escaped = () => Object.assign(new Error("Outside the folder."), { code: "EOUTSIDE" });

/**
 * Checks that an opened handle is the entry at `real` inside the root. Linux asks the
 * kernel for the handle's path. Elsewhere every folder between the root and `real` must
 * still be a real directory and the entry must be the opened one, so a folder swapped for
 * a symlink while the handle was opened is rejected.
 */
async function verifyOpened(root: string, real: string, handle: FileHandle): Promise<void> {
  if (process.platform === "linux") {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (actual !== undefined) {
      if (actual !== real || !inside(root, actual)) throw escaped();
      return;
    }
  }
  const opened = await handle.stat();
  let current = root;
  for (const part of real.slice(root.length).split(sep).filter(Boolean).slice(0, -1)) {
    current = join(current, part);
    if (!(await lstat(current)).isDirectory()) throw escaped();
  }
  const entry = await lstat(real);
  if (entry.isSymbolicLink() || entry.ino !== opened.ino || entry.dev !== opened.dev)
    throw escaped();
  if ((await realpath(real)) !== real) throw escaped();
}

/**
 * Opens a regular file inside a canonical root for reading, or returns undefined. The open
 * never follows a final symlink and never waits on a FIFO; the opened handle is then checked
 * to be a regular file at that path inside the root.
 */
export async function openContainedFile(
  root: string,
  relative: string,
): Promise<FileHandle | undefined> {
  const real = join(root, ...relative.split("/"));
  const handle = await open(
    real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile()) throw escaped();
    await verifyOpened(root, real, handle);
    return handle;
  } catch {
    await handle.close().catch(() => {});
    return undefined;
  }
}

/**
 * Reads a directory inside a canonical root, or returns undefined when it is no longer a
 * real directory there. Linux reads through the opened handle; elsewhere the handle is
 * checked again after reading, so a folder swapped for a symlink is not entered.
 */
export async function readContainedDirectory(
  root: string,
  relative: string,
): Promise<Dirent[] | undefined> {
  const real = relative ? join(root, ...relative.split("/")) : root;
  const handle = await open(
    real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    await verifyOpened(root, real, handle);
    const entries =
      process.platform === "linux"
        ? await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true }).catch(() =>
            readdir(real, { withFileTypes: true }),
          )
        : await readdir(real, { withFileTypes: true });
    if (process.platform !== "linux") await verifyOpened(root, real, handle);
    return entries;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
