import { readFile, stat } from "node:fs/promises";
import { decode } from "@irudd-scope/protocol";
import { LibrarianCommand } from "@irudd-scope/protocol/librarian";
import type { ScopeClient } from "@irudd-scope/protocol/client";

export async function librarianCommand(
  client: ScopeClient,
  action: string,
  file: string | undefined,
  signal: AbortSignal,
) {
  if (action === "read") return client.librarian({ action: "read" });
  if (action !== "apply" || !file)
    throw new Error("Use librarian guide, read, or apply REQUEST.json.");
  if ((await stat(file)).size > 2 * 1024 * 1024)
    throw new Error("Librarian command exceeds 2 MiB.");
  return client.librarian(
    decode(LibrarianCommand, JSON.parse(await readFile(file, { encoding: "utf8", signal }))),
  );
}
