import { GuestFolderBinding, GuestFolderPending } from "./folder-recovery-contract.ts";
import {
  FOLDER_OPERATION_RETENTION_MS,
  MAX_FOLDER_OPERATIONS,
} from "@irudd-scope/protocol/folder-operation";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { decode } from "@irudd-scope/protocol";
import { GuestInput, GuestPending, type GuestRecovery } from "./recovery-contract.ts";

type Storage = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  enqueue: <A>(action: () => Promise<A>) => Promise<A>;
};
export class GuestRecoveryStore {
  onChanged: (id: string) => void = () => {};
  constructor(private readonly storage: Storage) {}
  async initialize() {
    await this.storage.run(this.storage.sql`CREATE TABLE IF NOT EXISTS guest_folder_routes (
      caller TEXT NOT NULL, request_id TEXT NOT NULL, expires INTEGER NOT NULL,
      document TEXT NOT NULL CHECK(json_valid(document)), PRIMARY KEY(caller, request_id)) STRICT`);
    await this.storage.run(this.storage.sql`CREATE TABLE IF NOT EXISTS guest_recovery (
      guest_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      document TEXT NOT NULL CHECK(json_valid(document)), PRIMARY KEY(guest_id, kind, revision)) STRICT`);
  }
  read(id: string): Promise<GuestRecovery> {
    return this.storage.enqueue(async () => {
      const rows = await this.storage.run(
        this.storage.sql<{
          kind: string;
          document: string;
        }>`SELECT kind, document FROM guest_recovery WHERE guest_id = ${id} ORDER BY revision`,
      );
      return {
        inputs: rows
          .filter((row) => row.kind === "html" || row.kind === "action")
          .map((row) => decode(GuestInput, JSON.parse(row.document))),
        pending: rows.some((row) => row.kind === "operation")
          ? decode(GuestPending, JSON.parse(rows.find((row) => row.kind === "operation")!.document))
          : undefined,
      };
    });
  }
  async save(input: GuestInput) {
    const value = decode(GuestInput, input);
    if (new Set(value.fields.map((field) => field.key)).size !== value.fields.length)
      throw new Error("Ambiguous recovery fields cannot be saved.");
    if (value.kind === "html" && !value.blob)
      throw new Error("HTML recovery requires its original content identity.");
    const document = JSON.stringify(value);
    if (Buffer.byteLength(document) > 64 * 1024)
      throw new Error("Recovery input exceeds 64 KiB. Keep Scope open and copy your input.");
    const { sql } = this.storage;
    await this.storage.enqueue(() =>
      this.storage.run(
        sql.withTransaction(
          Effect.gen(function* () {
            const [guest] = yield* sql<{
              owner_id: string;
              source_id: string;
            }>`SELECT owner_id, source_id FROM guest_tabs WHERE id = ${value.guestId}`;
            if (guest?.owner_id !== value.ownerDeviceId || guest?.source_id !== value.sourceTabId)
              return yield* Effect.fail(new Error("Recovery input belongs to a different guest."));
            const [{ count, size }] = yield* sql<{
              count: number;
              size: number;
            }>`SELECT count(*) AS count, coalesce(sum(length(CAST(document AS BLOB))), 0) AS size FROM guest_recovery WHERE kind IN ('html', 'action') AND NOT (guest_id = ${value.guestId} AND kind = ${value.kind} AND revision = ${value.revision})`;
            if (count >= 4096 || size + Buffer.byteLength(document) > 16 * 1024 * 1024)
              return yield* Effect.fail(
                new Error(
                  "Recovery storage is full. Copy or discard older saved input before retrying.",
                ),
              );
            yield* sql`INSERT INTO guest_recovery VALUES (${value.guestId}, ${value.kind}, ${value.revision}, ${document}) ON CONFLICT(guest_id, kind, revision) DO UPDATE SET document = excluded.document`;
          }),
        ),
      ),
    );
    this.onChanged(value.guestId);
  }
  async pending(input: GuestPending) {
    const value = decode(GuestPending, input);
    if (
      value.operation.operationId !== value.outcome.operationId ||
      value.operation.digest !== value.outcome.digest
    )
      throw new Error("Owner outcome does not match the dispatched identity.");
    const document = JSON.stringify(value);
    if (Buffer.byteLength(document) > 34 * 1024 * 1024)
      throw new Error("Pending operation exceeds the plan input limit.");
    const { sql } = this.storage;
    await this.storage.enqueue(() =>
      this.storage.run(
        sql.withTransaction(
          Effect.gen(function* () {
            const [saved] = yield* sql<{
              document: string;
            }>`SELECT document FROM guest_recovery WHERE guest_id = ${value.guestId} AND kind = 'operation'`;
            if (saved) {
              const prior = decode(GuestPending, JSON.parse(saved.document));
              if (
                JSON.stringify(prior.operation) !== JSON.stringify(value.operation) ||
                (prior.dispatched && !value.dispatched)
              )
                return yield* Effect.fail(new Error("Reconcile the existing operation first."));
            }
            const [{ count }] = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM guest_recovery WHERE kind = 'operation' AND guest_id <> ${value.guestId}`;
            if (count >= 4)
              return yield* Effect.fail(
                new Error("Resolve a pending guest operation before starting another."),
              );
            yield* sql`INSERT INTO guest_recovery VALUES (${value.guestId}, 'operation', 0, ${document}) ON CONFLICT(guest_id, kind, revision) DO UPDATE SET document = excluded.document`;
          }),
        ),
      ),
    );
    this.onChanged(value.guestId);
  }
  async folderRead(id: string): Promise<GuestFolderPending | undefined> {
    return this.storage.enqueue(async () => {
      const [row] = await this.storage.run(
        this.storage.sql<{
          document: string;
        }>`SELECT document FROM guest_recovery WHERE guest_id = ${id} AND kind = 'folder'`,
      );
      return row ? decode(GuestFolderPending, JSON.parse(row.document)) : undefined;
    });
  }
  async folderSave(input: GuestFolderPending) {
    const value = decode(GuestFolderPending, input);
    const document = JSON.stringify(value);
    if (Buffer.byteLength(document) > 32 * 1024)
      throw new Error("Folder recovery input is too large.");
    const { sql } = this.storage;
    await this.storage.enqueue(() =>
      this.storage.run(
        sql.withTransaction(
          Effect.gen(function* () {
            const [guest] = yield* sql<{
              owner_id: string;
              source_id: string;
            }>`SELECT owner_id, source_id FROM guest_tabs WHERE id = ${value.guestId}`;
            if (
              guest?.owner_id !== value.write.target.ownerDeviceId ||
              guest?.source_id !== value.write.target.sourceTabId
            )
              return yield* Effect.fail(new Error("Folder recovery belongs to a different guest."));
            const [saved] = yield* sql<{
              document: string;
            }>`SELECT document FROM guest_recovery WHERE guest_id = ${value.guestId} AND kind = 'folder'`;
            if (
              saved &&
              JSON.stringify(decode(GuestFolderPending, JSON.parse(saved.document)).write) !==
                JSON.stringify(value.write)
            )
              return yield* Effect.fail(
                new Error("Check the previous folder operation before uploading again."),
              );
            const [{ count }] = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM guest_recovery WHERE kind = 'folder' AND guest_id <> ${value.guestId}`;
            if (count >= 32)
              return yield* Effect.fail(
                new Error("Resolve an existing folder upload before starting another."),
              );
            yield* sql`INSERT INTO guest_recovery VALUES (${value.guestId}, 'folder', 0, ${document}) ON CONFLICT(guest_id, kind, revision) DO UPDATE SET document = excluded.document`;
          }),
        ),
      ),
    );
    this.onChanged(value.guestId);
  }
  async folderClear(id: string, requestId: string) {
    await this.storage.enqueue(() =>
      this.storage.run(
        this.storage
          .sql`DELETE FROM guest_recovery WHERE guest_id = ${id} AND kind = 'folder' AND json_extract(document, '$.write.operation.requestId') = ${requestId}`,
      ),
    );
    this.onChanged(id);
  }
  async folderBinding(caller: string, requestId: string): Promise<GuestFolderBinding | undefined> {
    return this.storage.enqueue(async () => {
      const [row] = await this.storage.run(
        this.storage.sql<{
          document: string;
        }>`SELECT document FROM guest_folder_routes WHERE caller = ${caller} AND request_id = ${requestId}`,
      );
      return row ? decode(GuestFolderBinding, JSON.parse(row.document)) : undefined;
    });
  }
  async bindFolder(input: GuestFolderBinding) {
    const value = decode(GuestFolderBinding, input);
    const document = JSON.stringify(value);
    const requestId = value.write.operation.requestId;
    const expires = Number(requestId.split(":")[0]) + FOLDER_OPERATION_RETENTION_MS;
    const now = Date.now();
    if (expires <= now || expires > now + FOLDER_OPERATION_RETENTION_MS + 60_000)
      throw new Error("This folder operation identity has expired or has an invalid time.");
    const { sql } = this.storage;
    await this.storage.enqueue(() =>
      this.storage.run(
        sql.withTransaction(
          Effect.gen(function* () {
            const [saved] = yield* sql<{
              document: string;
            }>`SELECT document FROM guest_folder_routes WHERE caller = ${value.caller} AND request_id = ${requestId}`;
            if (saved) {
              if (saved.document !== document)
                return yield* Effect.fail(
                  new Error("Folder operation identity does not match its original request."),
                );
              return;
            }
            yield* sql`DELETE FROM guest_folder_routes WHERE expires <= ${now}`;
            const [{ count }] = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM guest_folder_routes`;
            if (count >= MAX_FOLDER_OPERATIONS)
              return yield* Effect.fail(
                new Error(
                  "Folder operation routing is full. Try again after older operations expire.",
                ),
              );
            yield* sql`INSERT INTO guest_folder_routes VALUES (${value.caller}, ${requestId}, ${expires}, ${document})`;
          }),
        ),
      ),
    );
  }
  async discard(id: string, kind: "html" | "action" | "operation", revision: number) {
    await this.storage.enqueue(() =>
      this.storage.run(
        this.storage
          .sql`DELETE FROM guest_recovery WHERE guest_id = ${id} AND kind = ${kind} AND revision = ${revision}`,
      ),
    );
    this.onChanged(id);
  }
}
