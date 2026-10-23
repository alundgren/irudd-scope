import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import { FolderError, resolveInside } from "./paths.ts";

export type FolderRead = {
  /** The whole file's size, independent of the requested range. */
  size: number;
  modifiedAt: number;
  /** Bytes from `start` up to but not including `end`, clamped to the file. */
  start: number;
  end: number;
  stream: Readable;
};

/**
 * Streams a byte range of a file inside a canonical root. The real path is checked before
 * opening, and the opened path is checked again so a swapped symlink cannot widen the read.
 */
export async function readFolderFile(
  root: string,
  relative: string,
  start: number,
  end?: number,
): Promise<FolderRead> {
  if (!relative) throw new FolderError("not-a-directory", "Choose a file inside the folder.");
  const real = await resolveInside(root, relative);
  const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FolderError("not-a-directory", `${relative} is not a file.`);
    if ((await realpath(real)) !== real)
      throw new FolderError("outside-folder", "Use a path inside the folder.");
    const last = Math.min(end ?? info.size, info.size);
    const first = Math.min(start, last);
    const range = { size: info.size, modifiedAt: info.mtimeMs, start: first, end: last };
    if (first === last) {
      await handle.close();
      return { ...range, stream: Readable.from([]) };
    }
    return { ...range, stream: handle.createReadStream({ start: first, end: last - 1 }) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
