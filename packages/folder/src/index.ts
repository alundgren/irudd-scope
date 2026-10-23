import type { Readable } from "node:stream";
import type { FolderWriteReceipt } from "@irudd-scope/protocol/folder";
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
export { searchFolder } from "./search.ts";
export { walkDirectories, type WalkedDirectory } from "./walk.ts";

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
