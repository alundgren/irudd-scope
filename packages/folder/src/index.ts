import type { Readable } from "node:stream";
import type {
  FolderSearchEvent,
  FolderSearchRequest,
  FolderWriteReceipt,
} from "@irudd-scope/protocol/folder";
import { FolderError } from "./paths.ts";

export {
  canonicalFolder,
  checkRoot,
  FolderError,
  openInside,
  readInsideText,
  resolveInside,
} from "./paths.ts";
export { listFolder, directoryIgnored } from "./listing.ts";
export { readFolderFile, type FolderRead } from "./read.ts";
export { watchFolder, type FolderWatch, type FolderWatchOptions } from "./watch.ts";
export { walkDirectories } from "./walk.ts";

/** Content search runs on the folder's machine. Implemented with filter and search. */
export function searchFolder(
  _input: FolderSearchRequest,
  _signal: AbortSignal,
): AsyncIterable<FolderSearchEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        Promise.reject(
          new FolderError("unsupported", "Searching folder contents is not available yet."),
        ),
    }),
  };
}

/**
 * Copies bytes into the folder by staging a temporary file inside the destination and
 * renaming it after checking containment again. Implemented with drops.
 */
export async function writeFolderFile(
  _root: string,
  _path: string,
  _body: Readable,
  _options: { replace: boolean; signal: AbortSignal },
): Promise<FolderWriteReceipt> {
  throw new FolderError("unsupported", "Copying files into a folder is not available yet.");
}
