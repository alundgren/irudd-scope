import { PassThrough } from "node:stream";
import type { HubState } from "./state.ts";
import {
  FOLDER_OPERATION_CAPABILITY,
  FOLDER_OPERATION_ROUTES,
  FolderOperationRequest,
  FolderOperationCaller,
  FolderOperationId,
  FOLDER_OPERATION_RETENTION_MS,
  MAX_FOLDER_OPERATIONS,
  FOLDER_UPLOAD_IDLE_MS,
} from "@irudd-scope/protocol/folder-operation";
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
  FolderRelativePath,
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
  folderFileVersion,
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

/**
 * Answers a failed folder request. Errors Scope did not expect, such as EACCES or EMFILE,
 * are 500 `failed` with the system error code, never `unsupported`, which the desktop shows
 * as a request to update Scope.
 */
export function folderFailure(response: ServerResponse, error: unknown) {
  if (error instanceof FolderError)
    send(response, error.status, folderErrorBody(error, error.code));
  else {
    const code = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
    send(response, 500, {
      error: `The hub could not complete the folder request${code}.`,
      code: "failed",
    } satisfies FolderErrorBody);
  }
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
  constructor(private readonly state: HubState) {}
  private operations = 0;
  private readonly active = new Set<ServerResponse>();
  private readonly feeds = new Set<ServerResponse>();

  /** Returns false when the path is not a folder file route. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const route = `${request.method} ${url.pathname}`;
    const routes: Record<string, () => Promise<void>> = {
      [`GET ${FOLDER_OPERATION_ROUTES.capabilities}`]: async () =>
        send(response, 200, {
          capabilities: [FOLDER_OPERATION_CAPABILITY],
          retentionMs: FOLDER_OPERATION_RETENTION_MS,
          maxOperations: MAX_FOLDER_OPERATIONS,
        }),
      [`GET ${FOLDER_OPERATION_ROUTES.version}`]: async () => {
        const input = query(url, Schema.Struct({ root: FolderPath, path: FolderRelativePath }), {
          root: "string",
          path: "string",
        });
        send(response, 200, { version: await folderFileVersion(input.root, input.path) });
      },
      [`GET ${FOLDER_OPERATION_ROUTES.status}`]: async () => {
        const input = query(
          url,
          Schema.Struct({ caller: FolderOperationCaller, requestId: FolderOperationId }),
          { caller: "string", requestId: "string" },
        );
        send(
          response,
          200,
          await this.state.folderOperations.status(
            this.state.folderCaller(input.caller),
            input.requestId,
          ),
        );
      },
      [`PUT ${FOLDER_OPERATION_ROUTES.execute}`]: () => this.operation(request, response, url),
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
      throw new FolderError("failed", "The hub is watching too many folders.");
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

  private async operation(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (this.operations >= 16) throw new FolderError("busy", "Too many folder uploads are active.");
    const input = query(url, Schema.Struct({ root: FolderPath, caller: FolderOperationCaller }), {
      root: "string",
      caller: "string",
    });
    let command: FolderOperationRequest;
    try {
      command = decode(
        FolderOperationRequest,
        JSON.parse(
          Buffer.from(String(request.headers["scope-folder-operation"]), "base64url").toString(
            "utf8",
          ),
        ),
      );
    } catch {
      throw new FolderError("request-mismatch", "Use a valid versioned folder operation.");
    }
    this.operations++;
    // A valid upload has its own idle limit; the journal service also bounds total time.
    const previousTimeout = request.socket.timeout ?? 0;
    request.setTimeout(FOLDER_UPLOAD_IDLE_MS);
    const controller = new AbortController();
    const body = new PassThrough();
    request.on("aborted", () => controller.abort());
    request.on("error", () => controller.abort());
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    request.pipe(body);
    try {
      const status = await this.state.folderOperations.execute(
        this.state.folderCaller(input.caller),
        input.root,
        command,
        body,
        controller.signal,
      );
      if (!request.complete) response.setHeader("Connection", "close");
      send(response, 200, status);
    } finally {
      this.operations--;
      request.setTimeout(previousTimeout);
      request.unpipe(body);
      // Early duplicate/expired answers close this connection instead of buffering the upload.
      if (!request.complete) {
        request.resume();
      }
    }
  }

  private async write(request: IncomingMessage, response: ServerResponse, url: URL) {
    const input = query(url, FolderWriteQuery, {
      root: "string",
      path: "string",
      replace: "boolean",
      directory: "boolean",
    });
    if (input.directory) {
      await createFolderDirectory(input.root, input.path, { exclusive: !input.replace });
      send(response, 200, { path: input.path, size: 0 });
      return;
    }
    // A desktop that cancels or disconnects before the answer is sent, even after the whole
    // body arrived, cancels the write: nothing is committed and the staged file is removed.
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
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
