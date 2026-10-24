import { createHash } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  FolderOperationCaller,
  FolderOperationId,
  FolderOperationRequest,
  FolderOperationStatus,
  FOLDER_OPERATION_RETENTION_MS,
  MAX_FOLDER_OPERATIONS,
  FOLDER_UPLOAD_IDLE_MS,
  FOLDER_UPLOAD_TOTAL_MS,
} from "@irudd-scope/protocol/folder-operation";
import { FolderPath, folderErrorBody } from "@irudd-scope/protocol/folder";
import { FolderError } from "./paths.ts";
import { serializeFolderWrites } from "./write-queue.ts";
import { createFolderDirectoryUnlocked, writeFolderFileUnlocked } from "./writer.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Journal = Schema.Struct({
  version: Schema.Literal(1),
  floor: Schema.Int,
  records: Schema.Array(
    Schema.Struct({
      key: Digest,
      fingerprint: Digest,
      status: FolderOperationStatus,
    }),
  ).check(Schema.isMaxLength(MAX_FOLDER_OPERATIONS)),
});
type Journal = typeof Journal.Type;
/** Each application implements this through its own existing SQLite owner. */
export type FolderOperationStorage = {
  read: () => Promise<unknown>;
  write: (document: Journal) => Promise<void>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const expiresAt = (id: string) => Number(id.split(":")[0]) + FOLDER_OPERATION_RETENTION_MS;

/** No database or transport ownership here. A single host instance uses its owner's journal. */
export class FolderOperations {
  private readonly active = new Set<string>();
  constructor(private readonly storage: FolderOperationStorage) {}

  private async journal(): Promise<Journal> {
    const saved = await this.storage.read();
    return saved === undefined ? { version: 1, floor: 0, records: [] } : decode(Journal, saved);
  }

  async status(caller: string, requestId: string): Promise<FolderOperationStatus> {
    decode(FolderOperationCaller, caller);
    decode(FolderOperationId, requestId);
    const journal = await this.journal();
    const key = hash(JSON.stringify([caller, requestId]));
    const expiration = expiresAt(requestId);
    if (expiration <= Math.max(Date.now(), journal.floor))
      return { requestId, state: "expired", expiresAt: expiration };
    const record = journal.records.find((record) => record.key === key);
    if (!record) return { requestId, state: "unknown", expiresAt: expiration };
    if (record.status.state === "pending" && !this.active.has(key))
      return { ...record.status, state: "unresolved" };
    return record.status;
  }

  async execute(
    caller: string,
    root: string,
    value: FolderOperationRequest,
    body: Readable,
    signal: AbortSignal,
  ): Promise<FolderOperationStatus> {
    // Cancellation is attached while queued; no listener puts the body into flowing mode.
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const total = setTimeout(
      () => controller.abort(new Error("The folder operation timed out.")),
      FOLDER_UPLOAD_TOTAL_MS,
    );
    total.unref();
    addAbortSignal(controller.signal, body);
    body.on("error", () => {});
    try {
      const input = decode(FolderOperationRequest, value);
      decode(FolderOperationCaller, caller);
      decode(FolderPath, root);
      return await serializeFolderWrites(() => this.perform(caller, root, input, body, controller));
    } finally {
      clearTimeout(total);
      signal.removeEventListener("abort", abort);
      // Includes duplicate/expired requests whose payload was deliberately not consumed.
      body.destroy();
    }
  }

  private async perform(
    caller: string,
    root: string,
    input: FolderOperationRequest,
    body: Readable,
    controller: AbortController,
  ): Promise<FolderOperationStatus> {
    controller.signal.throwIfAborted();
    const journal = await this.journal();
    const now = Math.max(Date.now(), journal.floor);
    const expiration = expiresAt(input.requestId);
    if (expiration <= now)
      return { requestId: input.requestId, state: "expired", expiresAt: expiration };
    if (Number(input.requestId.split(":")[0]) > now + 60_000)
      throw new FolderError(
        "expired",
        "The operation ID is in the future. Check the caller clock.",
      );
    const key = hash(JSON.stringify([caller, input.requestId]));
    // Explicit order prevents JSON property order from changing request identity.
    const fingerprint = hash(
      JSON.stringify([
        root,
        input.version,
        input.path,
        input.kind,
        input.expectedVersion,
        input.replace,
        input.payload.size,
        input.payload.sha256,
      ]),
    );
    const found = journal.records.find((record) => record.key === key);
    if (found) {
      if (found.fingerprint !== fingerprint)
        throw new FolderError(
          "request-mismatch",
          "This operation ID already belongs to a different request.",
        );
      return found.status.state === "pending"
        ? { ...found.status, state: "unresolved" }
        : found.status;
    }
    const records = journal.records.filter((record) => record.status.expiresAt > now);
    if (records.length >= MAX_FOLDER_OPERATIONS)
      throw new FolderError(
        "busy",
        "The folder operation journal is full. Wait for retained outcomes to expire.",
      );
    const record = {
      key,
      fingerprint,
      status: {
        requestId: input.requestId,
        state: "pending" as FolderOperationStatus["state"],
        expiresAt: expiration,
      },
    };
    const next: Journal = { version: 1, floor: now, records: [...records, record] };
    await this.storage.write(next);
    this.active.add(key);
    try {
      const receipt = await this.write(root, input, body, controller);
      const completed: FolderOperationStatus = { ...record.status, state: "completed", receipt };
      await this.storage.write({
        ...next,
        records: [...records, { ...record, status: completed }],
      });
      return completed;
    } catch (error) {
      // Only these errors prove the writer stopped before the file commit.
      const certain =
        error instanceof FolderError &&
        ["conflict", "request-mismatch", "exists"].includes(error.code);
      const status: FolderOperationStatus = {
        ...record.status,
        state: certain ? "failed" : "unresolved",
        error: folderErrorBody(error, "failed"),
      };
      await this.storage.write({ ...next, records: [...records, { ...record, status }] });
      return status;
    } finally {
      this.active.delete(key);
    }
  }

  private async write(
    root: string,
    input: FolderOperationRequest,
    body: Readable,
    controller: AbortController,
  ) {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => controller.abort(new Error("The folder upload stopped sending bytes.")),
        FOLDER_UPLOAD_IDLE_MS,
      );
      idle.unref();
    };
    refresh();
    const stream = Readable.from(
      (async function* () {
        for await (const chunk of body) {
          refresh();
          yield chunk;
        }
        clearTimeout(idle);
      })(),
    );
    try {
      if (input.kind === "directory") {
        for await (const chunk of stream) {
          if (chunk.length)
            throw new FolderError("request-mismatch", "Directory operations have no payload.");
        }
        controller.signal.throwIfAborted();
        await createFolderDirectoryUnlocked(root, input.path, { exclusive: true });
        return { path: input.path, size: 0 };
      }
      return await writeFolderFileUnlocked(root, input.path, stream, {
        replace: input.replace,
        expectedVersion: input.expectedVersion,
        payload: input.payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(idle);
      stream.destroy();
    }
  }
}
