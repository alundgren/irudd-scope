import {
  FOLDER_HEARTBEAT_MS,
  MAX_FOLDER_NAME_MATCHES,
  MAX_FOLDER_SEARCH_FILE_BYTES,
  MAX_FOLDER_SEARCH_MATCHES,
  type FolderSearchEvent,
  type FolderSearchRequest,
} from "@irudd-scope/protocol/folder";
import { checkRoot, openInside } from "./paths.ts";
import { directories } from "./walk.ts";

const MAX_LINE_TEXT = 4096;
/** Git treats a file with a NUL byte in its first 8000 bytes as binary. */
const BINARY_SNIFF_BYTES = 8000;

/** The text of a matching line, cut around the match when the line is very long. */
function lineText(line: string, index: number) {
  if (line.length <= MAX_LINE_TEXT) return line;
  const from = Math.max(0, index - 200);
  return line.slice(from, from + MAX_LINE_TEXT);
}

/**
 * Reads a small regular file inside the root, or nothing for links, FIFOs, large files,
 * binary files, and paths that a swapped folder would lead outside.
 */
async function readText(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const opened = await openInside(root, path, { internal: true, nonBlocking: true }).catch(
    () => undefined,
  );
  if (!opened) return undefined;
  const { handle } = opened;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FOLDER_SEARCH_FILE_BYTES) return undefined;
    const bytes = await handle.readFile({ signal });
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
    return bytes.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Searches a folder on the machine that has it, in any letter case. Content searches skip
 * binary files and files over 1 MiB; both kinds honour the ignored-files setting and never
 * enter `.git`. Ends with `done`, or stops early without it when the signal aborts.
 */
export async function* searchFolder(
  input: FolderSearchRequest,
  signal: AbortSignal,
): AsyncGenerator<FolderSearchEvent> {
  await checkRoot(input.root);
  const needle = input.query.toLowerCase();
  const limit = input.names ? MAX_FOLDER_NAME_MATCHES : MAX_FOLDER_SEARCH_MATCHES;
  let found = 0;
  let quietSince = Date.now();
  for await (const directory of directories(input.root, {
    signal,
    includeIgnored: input.showIgnored,
  })) {
    for (const name of directory.files) {
      if (signal.aborted) return;
      const path = directory.path ? `${directory.path}/${name}` : name;
      if (Date.now() - quietSince > FOLDER_HEARTBEAT_MS) {
        quietSince = Date.now();
        yield { type: "heartbeat" };
      }
      if (input.names) {
        if (!path.toLowerCase().includes(needle)) continue;
        yield { type: "file", path, ignored: directory.ignored.has(name) };
        quietSince = Date.now();
        if (++found >= limit) return yield { type: "done", truncated: true };
        continue;
      }
      if (directory.special.has(name)) continue;
      const text = await readText(input.root, path, signal);
      if (text === undefined) continue;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.replace(/\r$/, "");
        const at = line.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        yield { type: "match", path, line: index + 1, text: lineText(line, at) };
        quietSince = Date.now();
        if (++found >= limit) return yield { type: "done", truncated: true };
      }
    }
  }
  if (!signal.aborted) yield { type: "done", truncated: false };
}
