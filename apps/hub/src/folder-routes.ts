import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  FOLDER_FILE_MODIFIED_HEADER,
  FOLDER_FILE_ROUTES,
  FOLDER_FILE_SIZE_HEADER,
  FOLDER_HEARTBEAT_MS,
  FolderListQuery,
  FolderPath,
  FolderReadQuery,
  FolderSearchRequest,
  FolderWriteQuery,
  MAX_FOLDER_COMMAND_BYTES,
  folderErrorBody,
  readFolderQuery,
  type FolderErrorBody,
} from "@irudd-scope/protocol/folder";
import {
  FolderError,
  createFolderDirectory,
  listFolder,
  readFolderFile,
  searchFolder,
  watchFolder,
  writeFolderFile,
} from "@irudd-scope/folder";
import { readBody } from "./buffered-publication.ts";

const MAX_FEEDS = 64;

function send(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export function folderFailure(response: ServerResponse, error: unknown) {
  if (error instanceof FolderError)
    send(response, error.status, folderErrorBody(error, error.code));
  else
    send(response, 500, {
      error: "The hub could not complete the folder request.",
      code: "unsupported",
    } satisfies FolderErrorBody);
}

const FeedQuery = Schema.Struct({ root: FolderPath });

function query<S extends Schema.ConstraintDecoder<unknown>>(
  url: URL,
  schema: S,
  types: Parameters<typeof readFolderQuery>[1],
): S["Type"] {
  try {
    return decode(schema, readFolderQuery(url.searchParams, types));
  } catch {
    throw new FolderError("outside-folder", "Use a path inside the folder.");
  }
}

/** File routes for the paired desktop. The caller has already checked the desktop credential. */
export class FolderFileRoutes {
  private readonly active = new Set<ServerResponse>();
  private readonly feeds = new Set<ServerResponse>();

  /** Returns false when the path is not a folder file route. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const route = `${request.method} ${url.pathname}`;
    const routes: Record<string, () => Promise<void>> = {
      [`GET ${FOLDER_FILE_ROUTES.list}`]: () => this.list(response, url),
      [`GET ${FOLDER_FILE_ROUTES.read}`]: () => this.read(response, url),
      [`GET ${FOLDER_FILE_ROUTES.events}`]: () => this.events(request, response, url),
      [`POST ${FOLDER_FILE_ROUTES.search}`]: () => this.search(request, response, url),
      [`PUT ${FOLDER_FILE_ROUTES.write}`]: () => this.write(request, response, url),
    };
    const action = routes[route];
    if (!action) {
      if (!url.pathname.startsWith("/v1/relay/folders/")) return false;
      folderFailure(response, new FolderError("unsupported", "Folder endpoint not found."));
      return true;
    }
    this.active.add(response);
    response.on("close", () => this.active.delete(response));
    await action().catch((error: unknown) => folderFailure(response, error));
    return true;
  }

  private async list(response: ServerResponse, url: URL) {
    const input = query(url, FolderListQuery, {
      root: "string",
      path: "string",
      showIgnored: "boolean",
    });
    send(response, 200, await listFolder(input.root, input.path, input));
  }

  private async read(response: ServerResponse, url: URL) {
    const input = query(url, FolderReadQuery, {
      root: "string",
      path: "string",
      start: "number",
      end: "number",
    });
    const file = await readFolderFile(input.root, input.path, input.start, input.end);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": file.end - file.start,
      "Cache-Control": "no-store",
      [FOLDER_FILE_SIZE_HEADER]: String(file.size),
      [FOLDER_FILE_MODIFIED_HEADER]: String(Math.round(file.modifiedAt)),
    });
    await pipeline(file.stream, response).catch(() => response.destroy());
  }

  private async events(request: IncomingMessage, response: ServerResponse, url: URL) {
    const { root } = query(url, FeedQuery, { root: "string" });
    if (this.feeds.size >= MAX_FEEDS)
      throw new FolderError("unsupported", "The hub is watching too many folders.");
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    });
    this.feeds.add(response);
    const write = (value: unknown) => {
      if (!response.write(`${JSON.stringify(value)}\n`) && response.writableLength > 1024 * 1024)
        response.destroy();
    };
    const watcher = watchFolder(root, write);
    const heartbeat = setInterval(() => write({ type: "heartbeat" }), FOLDER_HEARTBEAT_MS);
    const stop = () => {
      this.feeds.delete(response);
      clearInterval(heartbeat);
      watcher.close();
    };
    request.on("close", stop);
    response.on("close", stop);
  }

  private async search(request: IncomingMessage, response: ServerResponse, _url: URL) {
    const body = await readBody(request, MAX_FOLDER_COMMAND_BYTES);
    let input;
    try {
      input = decode(FolderSearchRequest, JSON.parse(body.toString()));
    } catch {
      throw new FolderError("outside-folder", "Use a path inside the folder.");
    }
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    for await (const event of searchFolder(input, controller.signal)) {
      if (!response.headersSent)
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
        });
      response.write(`${JSON.stringify(event)}\n`);
    }
    response.end();
  }

  private async write(request: IncomingMessage, response: ServerResponse, url: URL) {
    const input = query(url, FolderWriteQuery, {
      root: "string",
      path: "string",
      replace: "boolean",
      directory: "boolean",
    });
    if (input.directory) {
      await createFolderDirectory(input.root, input.path);
      send(response, 200, { path: input.path, size: 0 });
      return;
    }
    // A desktop that cancels or disconnects ends the request before its body is complete;
    // the staged file is then removed.
    const controller = new AbortController();
    const stop = () => {
      if (!request.complete) controller.abort();
    };
    request.on("close", stop);
    response.on("close", stop);
    send(
      response,
      200,
      await writeFolderFile(input.root, input.path, request, {
        replace: input.replace,
        signal: controller.signal,
      }),
    );
  }

  /** Ends every file request, for example when the desktop's access is revoked. */
  closeAll() {
    for (const response of this.active) response.destroy();
    this.active.clear();
  }
}
