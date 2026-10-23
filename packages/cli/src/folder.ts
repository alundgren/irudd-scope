import { resolve } from "node:path";
import { hostname } from "node:os";
import { ScopeError } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { FolderOpenReceipt } from "@irudd-scope/protocol/folder";

/** Runs a folder command. The folder is resolved on this machine, where the files are. */
export async function folderCommand(
  connect: () => Promise<ScopeClient>,
  positionals: string[],
  values: { title?: string },
): Promise<FolderOpenReceipt> {
  const [, action, path, ...extra] = positionals;
  if (action !== "open" || extra.length)
    throw new Error("Use irudd-scope folder open [PATH] [--title TITLE].");
  if (values.title !== undefined && (!values.title.trim() || values.title.length > 160))
    throw new Error("Use a --title of 1 to 160 characters.");
  const client = await connect();
  try {
    return await client.folderOpen({
      path: resolve(path ?? "."),
      ...(values.title ? { title: values.title } : {}),
    });
  } catch (error) {
    // Hubs and desktops without folder support answer 404 without a folder error code.
    if (error instanceof ScopeError && error.status === 404 && !error.code)
      throw new Error(`Update Scope on ${hostname().split(".")[0]} to share folders.`);
    throw error;
  }
}
