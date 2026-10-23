import { Readable } from "node:stream";
import { FolderError, openInside } from "./paths.ts";

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
 * Streams a byte range of a file inside a canonical root. Bytes come from the opened handle,
 * which is checked to be inside the root, so a folder swapped for a symlink cannot widen it.
 */
export async function readFolderFile(
  root: string,
  relative: string,
  start: number,
  end?: number,
): Promise<FolderRead> {
  if (!relative) throw new FolderError("not-a-directory", "Choose a file inside the folder.");
  const { handle } = await openInside(root, relative);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FolderError("not-a-directory", `${relative} is not a file.`);
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
