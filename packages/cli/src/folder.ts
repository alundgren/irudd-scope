import { resolve } from "node:path";
import { hostname } from "node:os";
import { ScopeError } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type {
  FolderFindReceipt,
  FolderOpenReceipt,
  FolderSelectReceipt,
  FolderWatchEvent,
} from "@irudd-scope/protocol/folder";

const USAGE =
  "Use irudd-scope folder open [PATH] [--title TITLE], folder find [PATH], folder select PATH FILE [--title TITLE], or folder watch [PATH].";

// Hubs and desktops without folder support answer 404 without a folder error code.
function updateNeeded(error: unknown): never {
  if (error instanceof ScopeError && error.status === 404 && !error.code)
    throw new Error(`Update Scope on ${hostname().split(".")[0]} to share folders.`);
  throw error;
}

/** A file inside the folder, with `/` separators. Paths that leave the folder are refused here. */
function folderFile(file: string): string {
  const parts = file.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (/^(?:[\\/]|[A-Za-z]:)/.test(file) || !parts.length || parts.includes(".."))
    throw new Error("Use a FILE path inside the folder, relative to PATH, such as docs/plan.md.");
  return parts.join("/");
}

/** Runs a folder command. The folder is resolved on this machine, where the files are. */
export async function folderCommand(
  connect: () => Promise<ScopeClient>,
  positionals: string[],
  values: { title?: string },
): Promise<FolderOpenReceipt | FolderFindReceipt | FolderSelectReceipt> {
  const [, action, path, ...extra] = positionals;
  const file = action === "select" ? extra.shift() : undefined;
  if (
    !["open", "find", "select"].includes(action ?? "") ||
    extra.length ||
    (action === "select" && (!path || !file)) ||
    (action === "find" && values.title !== undefined)
  )
    throw new Error(USAGE);
  if (values.title !== undefined && (!values.title.trim() || values.title.length > 160))
    throw new Error("Use a --title of 1 to 160 characters.");
  const title = values.title ? { title: values.title } : {};
  const folder = resolve(path ?? ".");
  const selected = file === undefined ? undefined : folderFile(file);
  const client = await connect();
  try {
    if (action === "find") return await client.folderFind({ path: folder });
    if (selected !== undefined)
      return await client.folderSelect({ path: folder, file: selected, ...title });
    return await client.folderOpen({ path: folder, ...title });
  } catch (error) {
    return updateNeeded(error);
  }
}

/** Prints one JSON line per watch event until the Folder tab closes. */
export async function watchFolderCommand(
  connect: () => Promise<ScopeClient>,
  positionals: string[],
  signal: AbortSignal,
): Promise<void> {
  const [, , path, ...extra] = positionals;
  if (extra.length) throw new Error(USAGE);
  const folder = resolve(path ?? ".");
  const client = await connect();
  await client
    .folderWatch(
      folder,
      (event: FolderWatchEvent) => process.stdout.write(`${JSON.stringify(event)}\n`),
      signal,
      () => process.stderr.write(`Watching the Folder tab for ${folder}.\n`),
    )
    .catch(updateNeeded);
}
