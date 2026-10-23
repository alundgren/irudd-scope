import { buffer } from "node:stream/consumers";
import { decode } from "@irudd-scope/protocol";
import { readRemoteJson } from "@irudd-scope/protocol/remote";
import {
  FOLDER_FILE_ROUTES,
  FOLDER_FILE_SIZE_HEADER,
  FolderErrorBody,
  FolderFeedEvent,
  FolderListing,
  folderQuery,
  type FolderIdentity,
} from "@irudd-scope/protocol/folder";
import { FolderError, listFolder, readFolderFile, watchFolder } from "@irudd-scope/folder";
import { RemoteUnavailableError, type Remotes } from "../../remotes.ts";

/** Bytes read through IPC at once. Larger previews and saves stream instead. */
export const MAX_FOLDER_IPC_READ = 8 * 1024 * 1024;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;

export type FolderBytes = { size: number; start: number; bytes: Uint8Array };
/**
 * Where a Folder tab's files are read. Local folders use packages/folder directly; remote
 * folders use the hub's file routes. The Folder plugin does not otherwise know the difference.
 */
export type FolderSource = {
  list: (path: string, showIgnored: boolean, signal: AbortSignal) => Promise<FolderListing>;
  read: (path: string, start: number, end: number, signal: AbortSignal) => Promise<FolderBytes>;
  /** Delivers change feed events until the signal aborts or the feed fails. */
  events: (onEvent: (event: FolderFeedEvent) => void, signal: AbortSignal) => Promise<void>;
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
      return { size: file.size, start: file.start, bytes: await buffer(file.stream) };
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
  };
}

async function failure(response: Response): Promise<Error> {
  const body = await readRemoteJson(response, 8192).catch(() => undefined);
  try {
    const error = decode(FolderErrorBody, body);
    return new FolderError(error.code, error.error);
  } catch {
    if (response.status === 404) return new FolderUpdateNeeded();
    return new Error(`The remote returned ${response.status}.`);
  }
}

export function remoteFolderSource(remotes: Remotes, identity: FolderIdentity): FolderSource {
  const root = identity.path;
  const request = async (path: string, signal: AbortSignal, deadlineMs: number, idleMs: number) => {
    const response = await remotes.request(identity.machineId, path, {
      signal,
      deadlineMs,
      idleMs,
    });
    if (!response.ok) throw await failure(response);
    return response;
  };
  return {
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
      return { size: Number(response.headers.get(FOLDER_FILE_SIZE_HEADER)), start, bytes };
    },
    async events(onEvent, signal) {
      const query = folderQuery({ root });
      // The hub writes a heartbeat every 10 seconds, so 35 silent seconds means a lost feed.
      const response = await request(
        `${FOLDER_FILE_ROUTES.events}?${query}`,
        signal,
        2_147_483_647,
        35_000,
      );
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) throw new RemoteUnavailableError("The remote closed the folder feed.");
          pending += value;
          let boundary: number;
          while ((boundary = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, boundary);
            pending = pending.slice(boundary + 1);
            onEvent(decode(FolderFeedEvent, JSON.parse(line)));
          }
          if (pending.length > 1024 * 1024) throw new Error("The remote sent an oversized event.");
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}
