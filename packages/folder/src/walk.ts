import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GIT_DIRECTORY, IgnoreRules } from "./ignore-rules.ts";

export type WalkedDirectory = { path: string; files: string[]; directories: string[] };

/**
 * Visits the folder's directories that are not ignored, without following symlinks.
 * Ignored directories such as node_modules are neither read nor returned.
 */
export async function walkDirectories(
  root: string,
  visit: (directory: WalkedDirectory) => void | Promise<void>,
  options: { start?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const start = options.start ?? "";
  const queue: { path: string; rules: IgnoreRules }[] = [
    { path: start, rules: await IgnoreRules.load(root, start) },
  ];
  while (queue.length && !options.signal?.aborted) {
    const { path, rules } = queue.shift()!;
    const entries = await readdir(path ? join(root, ...path.split("/")) : root, {
      withFileTypes: true,
    }).catch(() => undefined);
    if (!entries) continue;
    const directory: WalkedDirectory = { path, files: [], directories: [] };
    for (const entry of entries) {
      if (entry.name === GIT_DIRECTORY) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (rules.ignores(child, entry.isDirectory())) continue;
      if (entry.isDirectory()) directory.directories.push(entry.name);
      else directory.files.push(entry.name);
    }
    await visit(directory);
    for (const name of directory.directories) {
      const child = path ? `${path}/${name}` : name;
      queue.push({ path: child, rules: await rules.child(root, child) });
    }
  }
}
