import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, addAbortSignal } from "node:stream";
import type { FolderErrorCode, FolderWriteReceipt } from "@irudd-scope/protocol/folder";
import { FolderError } from "./paths.ts";
import {
  allowWorkingDirectoryChanges,
  createDirectoryInProcess,
  procFolders,
  writeInProcess,
} from "./write.ts";

/** Chunks sent to the writer process that it has not taken yet; bounds memory per write. */
const WINDOW = 16;

type Request =
  | { type: "write"; id: number; root: string; path: string; replace: boolean }
  | { type: "chunk"; id: number; data: Uint8Array }
  | { type: "end"; id: number }
  | { type: "abort"; id: number }
  | { type: "directory"; id: number; root: string; path: string; exclusive: boolean };
type Reply =
  | { type: "taken"; id: number }
  | { type: "done"; id: number; receipt?: FolderWriteReceipt }
  | {
      type: "failed";
      id: number;
      name: string;
      message: string;
      code?: string;
      folderCode?: FolderErrorCode;
    };
type Pending = { receive: (reply: Reply) => void; fail: (error: Error) => void };

function replyError(reply: Extract<Reply, { type: "failed" }>): Error {
  if (reply.folderCode) return new FolderError(reply.folderCode, reply.message);
  return Object.assign(new Error(reply.message), {
    name: reply.name,
    ...(reply.code ? { code: reply.code } : {}),
  });
}

let writer: { child: ChildProcess; pending: Map<number, Pending> } | undefined;
let nextId = 1;

/** The writer entry beside the bundle that runs this code, or this package's source. */
function writerEntry() {
  const bundled = join(import.meta.dirname, "folder-writer.mjs");
  return existsSync(bundled) ? bundled : join(import.meta.dirname, "writer-process.ts");
}

/**
 * The long-lived folder writer process. Electron main and the hub never change their own
 * working directory; this process does, for directory-relative steps on macOS and Windows.
 * It is started on first use, holds no reference to keep its parent running while idle, and
 * is started again if it exits. Writes in progress when it exits fail.
 */
function folderWriter() {
  if (writer && writer.child.connected) return writer;
  const child = fork(writerEntry(), [], {
    execArgv: [],
    // Electron runs the entry as plain Node; Node ignores the variable.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const pending = new Map<number, Pending>();
  const current = { child, pending };
  writer = current;
  child.on("message", (reply: Reply) => pending.get(reply.id)?.receive(reply));
  const stopped = () => {
    if (writer === current) writer = undefined;
    for (const operation of [...pending.values()])
      operation.fail(new Error("Scope's folder writer stopped. Try again."));
  };
  child.once("exit", stopped);
  child.once("error", stopped);
  idle(current);
  return current;
}

/** The writer keeps the parent running only while it has work. */
function idle(current: NonNullable<typeof writer>) {
  const channel = current.child.channel as { ref(): void; unref(): void } | undefined;
  if (current.pending.size) {
    current.child.ref();
    channel?.ref();
  } else {
    current.child.unref();
    channel?.unref();
  }
}

function send(current: NonNullable<typeof writer>, request: Request) {
  if (current.child.connected) current.child.send(request);
}

/** Runs one request in the writer process and settles when it replies. */
function request<T>(
  start: Request,
  onReply: (reply: Reply, settle: (error?: Error, value?: T) => void) => void,
  feed?: (current: NonNullable<typeof writer>, settled: () => boolean) => Promise<void>,
): Promise<T> {
  const current = folderWriter();
  const id = start.id;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      current.pending.delete(id);
      idle(current);
      if (error) reject(error);
      else resolve(value as T);
    };
    current.pending.set(id, {
      receive: (reply) => {
        if (reply.type === "failed") settle(replyError(reply));
        else onReply(reply, settle);
      },
      fail: (error) => settle(error),
    });
    idle(current);
    send(current, start);
    feed?.(current, () => done).catch((error: unknown) => {
      // The body failed: the writer removes what it staged and replies.
      send(current, { type: "abort", id });
      if (!(error instanceof Error && error.name === "AbortError")) settle(error as Error);
    });
  });
}

async function writeThroughWriter(
  root: string,
  path: string,
  body: Readable,
  options: { replace: boolean; signal: AbortSignal },
): Promise<FolderWriteReceipt> {
  options.signal.throwIfAborted();
  const id = nextId++;
  let taken = 0;
  let sent = 0;
  let wake: (() => void) | undefined;
  let current: NonNullable<typeof writer> | undefined;
  const abort = () => current && send(current, { type: "abort", id });
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    return await request<FolderWriteReceipt>(
      { type: "write", id, root, path, replace: options.replace },
      (reply, settle) => {
        if (reply.type === "taken") {
          taken++;
          wake?.();
        } else if (reply.type === "done") settle(undefined, reply.receipt);
      },
      async (writerProcess, settled) => {
        current = writerProcess;
        for await (const chunk of addAbortSignal(options.signal, body) as AsyncIterable<Buffer>) {
          while (sent - taken >= WINDOW && !settled())
            await new Promise<void>((resolve) => (wake = resolve));
          if (settled()) return;
          send(writerProcess, { type: "chunk", id, data: chunk });
          sent++;
        }
        send(writerProcess, { type: "end", id });
      },
    );
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}

/**
 * Copies bytes into the folder. On Linux this runs here; elsewhere in the folder writer
 * process, with the bytes streamed to it. See `writeInProcess` for the guarantees.
 */
export function writeFolderFile(
  root: string,
  relative: string,
  body: Readable,
  options: { replace: boolean; signal: AbortSignal },
): Promise<FolderWriteReceipt> {
  if (procFolders) return writeInProcess(root, relative, body, options);
  return writeThroughWriter(root, relative, body, options);
}

/** Creates a folder inside the root; see `createDirectoryInProcess`. */
export function createFolderDirectory(
  root: string,
  relative: string,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  if (procFolders) return createDirectoryInProcess(root, relative, options);
  return request<void>(
    {
      type: "directory",
      id: nextId++,
      root,
      path: relative,
      exclusive: Boolean(options.exclusive),
    },
    (reply, settle) => {
      if (reply.type === "done") settle();
    },
  );
}

/**
 * Serves folder writes in the folder writer process until its parent disconnects. Writes
 * still running then are cancelled, which removes what they staged, before it exits.
 */
export function runFolderWriterProcess() {
  allowWorkingDirectoryChanges();
  type Operation = {
    controller: AbortController;
    chunks: Uint8Array[];
    ended: boolean;
    wake?: () => void;
  };
  const operations = new Map<number, Operation>();
  const running = new Set<Promise<void>>();
  const reply = (message: Reply) => {
    if (process.connected) process.send!(message);
  };
  const failure = (id: number, error: unknown): Reply => {
    const value = error instanceof Error ? error : new Error(String(error));
    return {
      type: "failed",
      id,
      name: value.name,
      message: value.message,
      ...("code" in value && typeof value.code === "string" ? { code: value.code } : {}),
      ...(value instanceof FolderError ? { folderCode: value.code } : {}),
    };
  };
  const track = (id: number, work: Promise<Reply>) => {
    const task = work
      .catch((error: unknown) => failure(id, error))
      .then((message) => {
        operations.delete(id);
        reply(message);
      });
    running.add(task);
    void task.finally(() => running.delete(task));
  };
  async function* chunks(id: number, operation: Operation) {
    // A cancelled write must stop waiting here, or the stream it feeds cannot close.
    while (!operation.controller.signal.aborted) {
      const chunk = operation.chunks.shift();
      if (chunk) {
        reply({ type: "taken", id });
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        continue;
      }
      if (operation.ended) return;
      await new Promise<void>((resolve) => (operation.wake = resolve));
      operation.wake = undefined;
    }
  }
  process.on("message", (message: Request) => {
    const operation = operations.get(message.id);
    if (message.type === "write") {
      const created: Operation = { controller: new AbortController(), chunks: [], ended: false };
      operations.set(message.id, created);
      track(
        message.id,
        writeInProcess(message.root, message.path, Readable.from(chunks(message.id, created)), {
          replace: message.replace,
          signal: created.controller.signal,
        }).then((receipt) => ({ type: "done", id: message.id, receipt })),
      );
    } else if (message.type === "directory") {
      track(
        message.id,
        createDirectoryInProcess(message.root, message.path, {
          exclusive: message.exclusive,
        }).then(() => ({ type: "done", id: message.id })),
      );
    } else if (operation && message.type === "chunk") {
      operation.chunks.push(message.data);
      operation.wake?.();
    } else if (operation && message.type === "end") {
      operation.ended = true;
      operation.wake?.();
    } else if (operation && message.type === "abort") {
      operation.controller.abort();
      operation.wake?.();
    }
  });
  process.once("disconnect", () => {
    for (const operation of operations.values()) {
      operation.controller.abort();
      operation.wake?.();
    }
    void Promise.allSettled([...running]).then(() => process.exit(0));
  });
}
