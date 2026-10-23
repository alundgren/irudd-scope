import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_FOLDER_LISTING_ENTRIES,
  type FolderEntry,
  type FolderListing,
} from "@irudd-scope/protocol/folder";
import { GIT_DIRECTORY, IgnoreRules } from "./ignore-rules.ts";
import {
  FolderError,
  inside,
  openInside,
  resolveInside,
  validRelative,
  verifyHandle,
} from "./paths.ts";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareEntries(a: FolderEntry, b: FolderEntry): number {
  const folders = Number(b.kind === "directory") - Number(a.kind === "directory");
  return folders || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
}

async function linkTarget(root: string, path: string): Promise<FolderEntry["link"]> {
  try {
    return inside(root, await realpath(path)) ? "inside" : "outside";
  } catch {
    return "broken";
  }
}

async function describe(
  root: string,
  directory: string,
  name: string,
  ignored: boolean,
): Promise<FolderEntry | undefined> {
  const path = directory ? `${directory}/${name}` : name;
  const absolute = join(root, ...path.split("/"));
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink()) {
    const link = await linkTarget(root, absolute);
    const target = link === "inside" ? await stat(absolute).catch(() => undefined) : undefined;
    return {
      name,
      path,
      kind: "symlink",
      link,
      ...(target?.isFile() ? { size: target.size } : {}),
      modifiedAt: info.mtimeMs,
      ignored,
    };
  }
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  return {
    name,
    path,
    kind,
    ...(kind === "file" ? { size: info.size } : {}),
    modifiedAt: info.mtimeMs,
    ignored,
  };
}

/**
 * Lists one directory of a folder. Only this directory is read, so the folder's size does
 * not change the cost. `.git` is never listed; ignored entries are omitted unless requested.
 */
export async function listFolder(
  root: string,
  relative: string,
  options: { showIgnored: boolean; directoryIgnored?: boolean },
): Promise<FolderListing> {
  const path = validRelative(relative);
  const real = await resolveInside(root, path);
  if (!(await stat(real)).isDirectory())
    throw new FolderError("not-a-directory", `${path} is not a folder.`);
  if (real !== (path ? join(root, ...path.split("/")) : root))
    throw new FolderError("outside-folder", "Symlinked folders are shown but not opened.");
  const rules = await IgnoreRules.load(root, path);
  const parentIgnored = options.directoryIgnored ?? (await directoryIgnored(root, path));
  const dirents = await readDirectory(root, path);
  const entries: FolderEntry[] = [];
  let truncated = false;
  const candidates = dirents.filter((entry) => entry.name !== GIT_DIRECTORY);
  for (let index = 0; index < candidates.length; index += 256) {
    const batch = await Promise.all(
      candidates.slice(index, index + 256).map((entry) => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const ignored = parentIgnored || rules.ignores(child, entry.isDirectory());
        if (ignored && !options.showIgnored) return Promise.resolve(undefined);
        return describe(root, path, entry.name, ignored);
      }),
    );
    for (const entry of batch) if (entry) entries.push(entry);
    if (entries.length >= MAX_FOLDER_LISTING_ENTRIES) {
      truncated = true;
      break;
    }
  }
  entries.sort(compareEntries);
  return { path, entries: entries.slice(0, MAX_FOLDER_LISTING_ENTRIES), truncated };
}

/**
 * Reads entry names from an opened directory handle. Linux reads through the handle itself;
 * elsewhere the handle is checked again after reading, so a swapped folder is rejected.
 */
export async function readDirectory(root: string, path: string, noSymlinks = false) {
  const { handle, real } = await openInside(root, path, { directory: true, noSymlinks });
  try {
    if (process.platform === "linux")
      return await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true }).catch(() =>
        readdir(real, { withFileTypes: true }),
      );
    const entries = await readdir(real, { withFileTypes: true });
    await verifyHandle(root, real, handle);
    return entries;
  } finally {
    await handle.close();
  }
}

/** Whether a directory, or any directory above it, is ignored. */
export async function directoryIgnored(root: string, path: string): Promise<boolean> {
  if (!path) return false;
  const parts = path.split("/");
  let rules = await IgnoreRules.load(root, "");
  for (let depth = 1; depth <= parts.length; depth++) {
    const current = parts.slice(0, depth).join("/");
    if (rules.ignores(current, true)) return true;
    if (depth < parts.length) rules = await rules.child(root, current);
  }
  return false;
}
