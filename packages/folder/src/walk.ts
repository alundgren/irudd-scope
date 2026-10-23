import { readContainedDirectory } from "./contained.ts";
import { GIT_DIRECTORY, IgnoreRules } from "./ignore-rules.ts";

export type WalkedDirectory = {
  path: string;
  files: string[];
  directories: string[];
  /** Names in this directory that ignore rules match. Empty unless ignored entries are included. */
  ignored: Set<string>;
  /** Names in `files` that are not regular files, such as symlinks and FIFOs. */
  special: Set<string>;
};
type WalkOptions = { start?: string; signal?: AbortSignal; includeIgnored?: boolean };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Yields the folder's directories breadth first, without following symlinks. A directory
 * is entered only while it is still a real directory inside the root. Ignored directories
 * such as node_modules are neither read nor returned unless requested.
 */
export async function* directories(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkedDirectory> {
  const start = options.start ?? "";
  const queue: { path: string; rules: IgnoreRules; ignoredAbove: boolean }[] = [
    { path: start, rules: await IgnoreRules.load(root, start), ignoredAbove: false },
  ];
  while (queue.length && !options.signal?.aborted) {
    const { path, rules, ignoredAbove } = queue.shift()!;
    const entries = await readContainedDirectory(root, path);
    if (!entries) continue;
    entries.sort((a, b) => collator.compare(a.name, b.name));
    const directory: WalkedDirectory = {
      path,
      files: [],
      directories: [],
      ignored: new Set(),
      special: new Set(),
    };
    for (const entry of entries) {
      if (entry.name === GIT_DIRECTORY) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (ignoredAbove || rules.ignores(child, entry.isDirectory())) {
        if (!options.includeIgnored) continue;
        directory.ignored.add(entry.name);
      }
      if (entry.isDirectory()) directory.directories.push(entry.name);
      else {
        directory.files.push(entry.name);
        if (!entry.isFile()) directory.special.add(entry.name);
      }
    }
    yield directory;
    for (const name of directory.directories) {
      const child = path ? `${path}/${name}` : name;
      queue.push({
        path: child,
        rules: await rules.child(root, child),
        ignoredAbove: ignoredAbove || directory.ignored.has(name),
      });
    }
  }
}

/** Calls `visit` for each directory that `directories` yields. */
export async function walkDirectories(
  root: string,
  visit: (directory: WalkedDirectory) => void | Promise<void>,
  options: WalkOptions = {},
): Promise<void> {
  for await (const directory of directories(root, options)) await visit(directory);
}
