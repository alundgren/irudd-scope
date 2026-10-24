import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { decode } from "@irudd-scope/protocol";
import { readRemoteJson } from "@irudd-scope/protocol/remote";
import {
  FOLDER_FILE_MODIFIED_HEADER,
  FOLDER_FILE_ROUTES,
  FOLDER_FILE_SIZE_HEADER,
  FolderErrorBody,
  FolderFeedEvent,
  FolderListing,
  FolderSearchEvent,
  FolderWriteReceipt,
  folderQuery,
  type FolderIdentity,
  type FolderSearchRequest,
} from "@irudd-scope/protocol/folder";
import {
  FolderError,
  createFolderDirectory,
  listFolder,
  readFolderFile,
  searchFolder,
  walkDirectories,
  watchFolder,
  writeFolderFile,
} from "@irudd-scope/folder";
import { RemoteUnavailableError, type RemoteRequest, type Remotes } from "../../remotes.ts";

/** Bytes read through IPC at once. Larger previews and saves stream instead. */
export const MAX_FOLDER_IPC_READ = 8 * 1024 * 1024;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
/** The longest one save or dropped file may take. */
const MAX_TRANSFER_MS = 12 * 60 * 60_000;

export type FolderBytes = { size: number; modifiedAt: number; start: number; bytes: Uint8Array };
/** One directory found by a walk: its direct children. */
export type FolderDirectory = {
  path: string;
  entries: { name: string; directory: boolean; ignored: boolean }[];
  /** The directory had more entries than one listing returns. */
  truncated: boolean;
};
export type FolderSearchInput = Omit<FolderSearchRequest, "root">;
/** Directories a remote walk lists at once, leaving room for the feed and previews. */
const REMOTE_WALK_REQUESTS = 4;
/**
 * Where a Folder tab's files are read. Local folders use packages/folder directly; remote
 * folders use the hub's file routes. The Folder plugin does not otherwise know the difference.
 */
export type FolderSource = {
  list: (path: string, showIgnored: boolean, signal: AbortSignal) => Promise<FolderListing>;
  read: (path: string, start: number, end: number, signal: AbortSignal) => Promise<FolderBytes>;
  /** Delivers change feed events until the signal aborts or the feed fails. */
  events: (onEvent: (event: FolderFeedEvent) => void, signal: AbortSignal) => Promise<void>;
  /** Visits every directory from `start` down, skipping ignored ones unless shown. */
  walk: (
    start: string,
    showIgnored: boolean,
    onDirectory: (directory: FolderDirectory) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Searches on the machine that has the files, delivering events until `done`. */
  search: (
    input: FolderSearchInput,
    onEvent: (event: FolderSearchEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Streams a whole file, for saving it to this computer. */
  download: (path: string, signal: AbortSignal) => Promise<{ size: number; stream: Readable }>;
  /**
   * Copies bytes into the folder through a staged file. Without `replace` an existing
   * entry fails with `exists`. Missing folders on the way are created.
   */
  write: (
    path: string,
    body: Readable,
    replace: boolean,
    signal: AbortSignal,
  ) => Promise<FolderWriteReceipt>;
  /** Creates a folder; without `replace` an existing entry fails with `exists`. */
  createDirectory: (path: string, replace: boolean, signal: AbortSignal) => Promise<void>;
};

/** The remote answered 404 without a folder code: its hub predates folder support. */
export class FolderUpdateNeeded extends Error {
  constructor() {
    super("The remote needs a newer Scope to show folders.");
    this.name = "FolderUpdateNeeded";
  }
}

export function localFolderSource(root: string): FolderSource {
  return {
    list: (path, showIgnored) => listFolder(root, path, { showIgnored }),
    async read(path, start, end) {
      const file = await readFolderFile(
        root,
        path,
        start,
        Math.min(end, start + MAX_FOLDER_IPC_READ),
      );
      return {
        size: file.size,
        modifiedAt: file.modifiedAt,
        start: file.start,
        bytes: await buffer(file.stream),
      };
    },
    events: (onEvent, signal) =>
      new Promise<void>((resolve) => {
        const watcher = watchFolder(root, onEvent);
        signal.addEventListener(
          "abort",
          () => {
            watcher.close();
            resolve();
          },
          { once: true },
        );
      }),
    walk: (start, showIgnored, onDirectory, signal) =>
      walkDirectories(
        root,
        (directory) =>
          onDirectory({
            path: directory.path,
            entries: [
              ...directory.directories.map((name) => ({ name, directory: true })),
              ...directory.files.map((name) => ({ name, directory: false })),
            ].map((entry) => ({ ...entry, ignored: directory.ignored.has(entry.name) })),
            truncated: false,
          }),
        { start, signal, includeIgnored: showIgnored },
      ),
    async search(input, onEvent, signal) {
      for await (const event of searchFolder({ ...input, root }, signal)) onEvent(event);
    },
    async download(path, signal) {
      const file = await readFolderFile(root, path, 0);
      signal.addEventListener("abort", () => file.stream.destroy(signal.reason), { once: true });
      return { size: file.size, stream: file.stream };
    },
    write: (path, body, replace, signal) => writeFolderFile(root, path, body, { replace, signal }),
    createDirectory: (path, replace) => createFolderDirectory(root, path, { exclusive: !replace }),
  };
}

/** Reads NDJSON lines from a response body until it ends or the signal aborts. */
async function readLines(
  response: Response,
  signal: AbortSignal,
  onLine: (line: string) => boolean | void,
) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return false;
      pending += value;
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (onLine(line) === true) return true;
      }
      if (pending.length > 1024 * 1024) throw new Error("The remote sent an oversized event.");
    }
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function failure(response: Response): Promise<Error> {
  const body = await readRemoteJson(response, 8192).catch(() => undefined);
  try {
    const error = decode(FolderErrorBody, body);
    // Only a 501 `unsupported` means the remote's Scope lacks the feature.
    if (error.code === "unsupported" && response.status !== 501)
      return new FolderError("failed", error.error);
    return new FolderError(error.code, error.error);
  } catch {
    if (response.status === 404) return new FolderUpdateNeeded();
    return new Error(`The remote returned ${response.status}.`);
  }
}

export function remoteFolderSource(remotes: Remotes, identity: FolderIdentity): FolderSource {
  const root = identity.path;
  const request = async (
    path: string,
    signal: AbortSignal,
    deadlineMs: number,
    idleMs: number,
    init: Pick<RemoteRequest, "method" | "body" | "contentType" | "feed"> = {},
  ) => {
    const response = await remotes.request(identity.machineId, path, {
      ...init,
      signal,
      deadlineMs,
      idleMs,
    });
    if (!response.ok) throw await failure(response);
    return response;
  };
  const source: FolderSource = {
    async list(path, showIgnored, signal) {
      const query = folderQuery({ root, path, showIgnored });
      const response = await request(`${FOLDER_FILE_ROUTES.list}?${query}`, signal, 60_000, 20_000);
      return decode(FolderListing, await readRemoteJson(response, MAX_LISTING_BYTES));
    },
    async read(path, start, end, signal) {
      const query = folderQuery({
        root,
        path,
        start,
        end: Math.min(end, start + MAX_FOLDER_IPC_READ),
      });
      const response = await request(
        `${FOLDER_FILE_ROUTES.read}?${query}`,
        signal,
        120_000,
        20_000,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_FOLDER_IPC_READ)
        throw new Error("The remote sent too many bytes.");
      return {
        size: Number(response.headers.get(FOLDER_FILE_SIZE_HEADER)),
        // Hubs from before previews send no modification time.
        modifiedAt: Number(response.headers.get(FOLDER_FILE_MODIFIED_HEADER) ?? Number.NaN),
        start,
        bytes,
      };
    },
    async events(onEvent, signal) {
      const query = folderQuery({ root });
      // The hub writes a heartbeat every 10 seconds, so 35 silent seconds means a lost feed.
      const response = await request(
        `${FOLDER_FILE_ROUTES.events}?${query}`,
        signal,
        2_147_483_647,
        35_000,
        { feed: true },
      );
      await readLines(response, signal, (line) => {
        onEvent(decode(FolderFeedEvent, JSON.parse(line)));
      });
      if (!signal.aborted) throw new RemoteUnavailableError("The remote closed the folder feed.");
    },
    async walk(start, showIgnored, onDirectory, signal) {
      const queue = [start];
      let active = 0;
      await new Promise<void>((resolve, reject) => {
        const next = () => {
          if (signal.aborted) return resolve();
          if (!queue.length && !active) return resolve();
          while (active < REMOTE_WALK_REQUESTS && queue.length) {
            const path = queue.shift()!;
            active++;
            source
              .list(path, showIgnored, signal)
              .then((listing) => {
                active--;
                onDirectory({
                  path,
                  entries: listing.entries.map((entry) => ({
                    name: entry.name,
                    directory: entry.kind === "directory",
                    ignored: entry.ignored,
                  })),
                  truncated: listing.truncated,
                });
                for (const entry of listing.entries)
                  if (entry.kind === "directory") queue.push(entry.path);
                next();
              })
              .catch((error: unknown) => {
                active--;
                // A directory removed during the walk is skipped; anything else stops it.
                if (error instanceof FolderError && error.code === "not-found" && path) next();
                else reject(error);
              });
          }
        };
        next();
      });
    },
    async search(input, onEvent, signal) {
      const response = await request(FOLDER_FILE_ROUTES.search, signal, 30 * 60_000, 35_000, {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ ...input, root }),
      });
      const done = await readLines(response, signal, (line) => {
        const event = decode(FolderSearchEvent, JSON.parse(line));
        onEvent(event);
        return event.type === "done";
      });
      if (!done && !signal.aborted)
        throw new RemoteUnavailableError("The remote stopped searching.");
    },
    async download(path, signal) {
      const query = folderQuery({ root, path, start: 0 });
      // Saves of large files can take hours; a silent response for 60 seconds fails it.
      const response = await request(
        `${FOLDER_FILE_ROUTES.read}?${query}`,
        signal,
        MAX_TRANSFER_MS,
        60_000,
      );
      return {
        size: Number(response.headers.get(FOLDER_FILE_SIZE_HEADER)),
        stream: Readable.fromWeb(response.body! as NodeReadableStream),
      };
    },
    async write(path, body, replace, signal) {
      const query = folderQuery({ root, path, replace });
      const response = await request(
        `${FOLDER_FILE_ROUTES.write}?${query}`,
        signal,
        MAX_TRANSFER_MS,
        60_000,
        {
          method: "PUT",
          contentType: "application/octet-stream",
          body,
        },
      );
      return decode(FolderWriteReceipt, await readRemoteJson(response, 64 * 1024));
    },
    async createDirectory(path, replace, signal) {
      const query = folderQuery({ root, path, replace, directory: true });
      const response = await request(
        `${FOLDER_FILE_ROUTES.write}?${query}`,
        signal,
        60_000,
        20_000,
        {
          method: "PUT",
          contentType: "application/octet-stream",
          body: Readable.from([]),
        },
      );
      await response.body?.cancel();
    },
  };
  return source;
}
