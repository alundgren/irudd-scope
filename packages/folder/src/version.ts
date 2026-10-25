import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { openInside, FolderError } from "./paths.ts";

export function fileVersion(info: BigIntStats): string {
  return createHash("sha256")
    .update([info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":"))
    .digest("hex");
}

/** An observation, not a lock against changes by other programs. */
export async function folderFileVersion(root: string, path: string): Promise<string> {
  try {
    const { handle } = await openInside(root, path, { nonBlocking: true, noSymlinks: true });
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw new FolderError("not-a-directory", "Choose a regular file.");
      return fileVersion(info);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof FolderError && error.code === "not-found") return "missing";
    throw error;
  }
}
