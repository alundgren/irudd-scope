import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessFolderSize } from "@irudd-scope/protocol/harnesses";
import { compareNames, lstatOrNull } from "./files.ts";

const largestPartCount = 5;
const statBatch = 64;
const MAX_PART_NAME = 255;

/**
 * Totals the regular files below `root`, which the caller checked is a real directory below
 * home, with `lstat`. Links are never followed and add nothing, so a link to a large folder
 * elsewhere cannot change the total. Directories and other entries add nothing either, which
 * keeps totals the same on every file system. Parts are the top-level entries, largest first.
 */
export async function measureFolder(
  root: string,
  signal: AbortSignal,
): Promise<HarnessFolderSize | null> {
  if (!(await lstatOrNull(root))?.isDirectory()) return null;
  const parts = new Map<string, number>();
  let bytes = 0;
  let files = 0;
  const pending: Array<{ path: string; part: string | null }> = [{ path: root, part: null }];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const folder = pending.pop()!;
    let entries;
    try {
      entries = await readdir(folder.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let start = 0; start < entries.length; start += statBatch) {
      signal.throwIfAborted();
      const batch = entries.slice(start, start + statBatch);
      const sizes = await Promise.all(
        batch.map(async (entry) => {
          const path = join(folder.path, entry.name);
          const part = folder.part ?? entry.name;
          if (entry.isSymbolicLink()) return null;
          if (entry.isDirectory()) {
            pending.push({ path, part });
            return { part, size: 0 };
          }
          try {
            const info = await lstat(path);
            if (info.isDirectory()) {
              pending.push({ path, part });
              return { part, size: 0 };
            }
            return info.isFile() ? { part, size: info.size, file: true } : null;
          } catch {
            return null;
          }
        }),
      );
      for (const entry of sizes) {
        if (!entry) continue;
        parts.set(entry.part, (parts.get(entry.part) ?? 0) + entry.size);
        if ("file" in entry) {
          bytes += entry.size;
          files += 1;
        }
      }
    }
  }
  // Bytes under a name too long for the scan still count in the total, not as a part.
  const largest = [...parts]
    .filter(([name]) => name.length <= MAX_PART_NAME)
    .map(([name, size]) => ({ name, bytes: size }))
    .sort((left, right) => right.bytes - left.bytes || compareNames(left.name, right.name))
    .slice(0, largestPartCount);
  return { state: "done", bytes, files, parts: largest };
}
