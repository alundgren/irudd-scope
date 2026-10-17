import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { zipSync } from "fflate";
import { BlobId, ScopeError, decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  PromptCommand,
  PromptReply,
  PromptWorkspace,
  PromptItem,
  PromptImage,
  PromptItemId,
  PromptReceipt,
  PromptExportManifest,
  PROMPT_STRUCTURE,
  PROMPT_FIELDS,
  PROMPT_PAGE_SIZE,
  MAX_PROMPT_ITEMS,
  MAX_PROMPT_EXPORT_BYTES,
  MAX_PROMPT_REPLY_BYTES,
  emptyPromptDocument,
  assemblePrompt,
} from "@irudd-scope/protocol/prompts";
import { validatePromptImage, promptImageFile } from "./prompt-image.ts";

type Database = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  mutate: <A, E>(effect: Effect.Effect<A, E>, events: (result: A) => LiveEvent[]) => Promise<A>;
};
type State = { workspace: string; library_revision: number };
type ItemRow = { document: string };
function payloadHash(command: PromptCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify(command, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");
}
function boundedReply(value: PromptReply): PromptReply {
  const reply = decode(PromptReply, value);
  if (Buffer.byteLength(JSON.stringify(reply)) > MAX_PROMPT_REPLY_BYTES)
    throw new ScopeError(413, "Prompt reply exceeds 2 MiB. Narrow the library search.");
  return reply;
}

function readItems(
  sql: SqliteClient.SqliteClient,
  command: Extract<PromptCommand, { action: "list-items" }>,
  libraryRevision: number,
) {
  return Effect.gen(function* () {
    if (command.cursor && command.cursor.revision !== libraryRevision)
      return yield* Effect.fail(
        new ScopeError(409, "Prompt library changed. Restart pagination without a cursor."),
      );
    let after = command.cursor?.after ?? "";
    const field = command.field ?? "";
    const search = (command.search ?? "").toLowerCase();
    const matches: PromptItem[] = [];
    while (matches.length <= PROMPT_PAGE_SIZE) {
      const rows =
        yield* sql<ItemRow>`SELECT document FROM prompt_items WHERE id > ${after} AND (${field} = '' OR json_extract(document, '$.field') = ${field}) ORDER BY id LIMIT 100`;
      for (const row of rows) {
        const item = decode(PromptItem, JSON.parse(row.document));
        after = item.id;
        if (
          `${item.name} ${item.fragment} ${item.description ?? ""}`.toLowerCase().includes(search)
        )
          matches.push(item);
        if (matches.length > PROMPT_PAGE_SIZE) break;
      }
      if (rows.length < 100) break;
    }
    const items = matches.slice(0, PROMPT_PAGE_SIZE);
    return {
      type: "items" as const,
      libraryRevision,
      items,
      next:
        matches.length > PROMPT_PAGE_SIZE
          ? { revision: libraryRevision, after: items.at(-1)!.id }
          : null,
    };
  });
}

export class PromptStore {
  constructor(private readonly database: Database) {}
  async initialize(): Promise<void> {
    const { sql, run } = this.database;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS prompt_state (id INTEGER PRIMARY KEY CHECK(id = 1), workspace TEXT NOT NULL CHECK(json_valid(workspace)), library_revision INTEGER NOT NULL CHECK(library_revision >= 0)) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS prompt_images (id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), content BLOB NOT NULL CHECK(length(content) <= 8388608)) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS prompt_items (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)), image_id TEXT REFERENCES prompt_images(id)) STRICT`;
          yield* sql`CREATE INDEX IF NOT EXISTS prompt_items_image ON prompt_items(image_id)`;
          yield* sql`CREATE TABLE IF NOT EXISTS prompt_receipts (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt))) STRICT`;
          yield* sql`CREATE INDEX IF NOT EXISTS prompt_created_items ON prompt_receipts(json_extract(receipt, '$.itemId')) WHERE json_extract(receipt, '$.action') = 'create-item'`;
          const workspace = JSON.stringify({ revision: 0, document: emptyPromptDocument() });
          yield* sql`INSERT INTO prompt_state VALUES (1, ${workspace}, 0) ON CONFLICT(id) DO NOTHING`;
          yield* sql`PRAGMA user_version = 14`;
        }),
      ),
    );
  }
  async command(value: PromptCommand): Promise<PromptReply> {
    const command = decode(PromptCommand, value);
    const { sql, mutate } = this.database;
    const result = await mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const [state] =
            yield* sql<State>`SELECT workspace, library_revision FROM prompt_state WHERE id = 1`;
          let workspace = decode(PromptWorkspace, JSON.parse(state.workspace));
          let libraryRevision = state.library_revision;
          const itemById = (id: string) =>
            Effect.gen(function* () {
              const [row] = yield* sql<ItemRow>`SELECT document FROM prompt_items WHERE id = ${id}`;
              if (!row)
                return yield* Effect.fail(new ScopeError(404, "Prompt library item not found."));
              return decode(PromptItem, JSON.parse(row.document));
            });
          const read = (reply: PromptReply) => ({
            reply: boundedReply(reply),
            events: [] as LiveEvent[],
          });
          if (command.action === "structures")
            return read({ type: "structures", structures: [PROMPT_STRUCTURE] });
          if (command.action === "read-workspace")
            return read({
              type: "workspace",
              workspace,
              rendered: assemblePrompt(workspace.document),
            });
          if (command.action === "read-item")
            return read({ type: "item", libraryRevision, item: yield* itemById(command.id) });
          if (command.action === "list-items")
            return read(yield* readItems(sql, command, libraryRevision));
          const hash = payloadHash(command);
          const [saved] = yield* sql<{
            payload_hash: string;
            receipt: string;
          }>`SELECT payload_hash, receipt FROM prompt_receipts WHERE request_id = ${command.requestId}`;
          if (saved) {
            if (saved.payload_hash !== hash)
              return yield* Effect.fail(
                new ScopeError(
                  409,
                  "This prompt request ID was already used with different content.",
                ),
              );
            return read(decode(PromptReceipt, JSON.parse(saved.receipt)));
          }
          let workspaceChanged = false;
          let libraryChanged = false;
          let itemId: string | undefined;
          let itemRevision: number | undefined;
          if (command.action === "update-workspace" || command.action === "reset-workspace") {
            if (command.expectedRevision !== workspace.revision)
              return yield* Effect.fail(
                new ScopeError(409, "Current prompt changed. Read it before retrying."),
              );
            const document =
              command.action === "reset-workspace" ? emptyPromptDocument() : command.document;
            for (const field of PROMPT_FIELDS) {
              const id = document.parts[field].itemId;
              if (!id) continue;
              const item = yield* itemById(id);
              if (
                item.field !== field ||
                item.structureId !== document.structureId ||
                item.structureVersion !== document.structureVersion
              )
                return yield* Effect.fail(
                  new ScopeError(
                    400,
                    "Selected prompt item does not belong to this field and structure.",
                  ),
                );
            }
            workspace = decode(PromptWorkspace, { revision: workspace.revision + 1, document });
            workspaceChanged = true;
          } else {
            itemId = command.id;
            const [row] =
              yield* sql<ItemRow>`SELECT document FROM prompt_items WHERE id = ${command.id}`;
            const current = row ? decode(PromptItem, JSON.parse(row.document)) : undefined;
            if (command.action === "create-item") {
              if (command.expectedRevision !== 0 || current)
                return yield* Effect.fail(
                  new ScopeError(
                    409,
                    "Prompt item already exists or expectedRevision is not zero.",
                  ),
                );
              const [createdBefore] =
                yield* sql`SELECT 1 FROM prompt_receipts WHERE json_extract(receipt, '$.itemId') = ${command.id} AND json_extract(receipt, '$.action') = 'create-item' LIMIT 1`;
              if (createdBefore)
                return yield* Effect.fail(
                  new ScopeError(
                    409,
                    "Prompt item IDs cannot be reused after deletion. Choose a new UUID.",
                  ),
                );
              const [{ count }] = yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM prompt_items`;
              if (count >= MAX_PROMPT_ITEMS)
                return yield* Effect.fail(
                  new ScopeError(413, "Prompt library is limited to 2000 items."),
                );
              const item = decode(PromptItem, { ...command.item, id: command.id, revision: 1 });
              yield* sql`INSERT INTO prompt_items(id, document) VALUES (${item.id}, ${JSON.stringify(item)})`;
              itemRevision = item.revision;
            } else {
              if (!current)
                return yield* Effect.fail(new ScopeError(404, "Prompt library item not found."));
              if (current.revision !== command.expectedRevision)
                return yield* Effect.fail(
                  new ScopeError(409, "Prompt item changed. Read it before retrying."),
                );
              itemRevision = current.revision + 1;
              if (command.action === "delete-item") {
                yield* sql`DELETE FROM prompt_items WHERE id = ${current.id}`;
                const document = { ...workspace.document, parts: { ...workspace.document.parts } };
                for (const field of PROMPT_FIELDS)
                  if (document.parts[field].itemId === current.id) {
                    document.parts[field] = { itemId: null, text: document.parts[field].text };
                    workspaceChanged = true;
                  }
                if (workspaceChanged)
                  workspace = decode(PromptWorkspace, {
                    revision: workspace.revision + 1,
                    document,
                  });
              } else {
                let image = current.image;
                if (command.action === "set-image") {
                  image = undefined;
                  if (command.image) {
                    const validated = yield* Effect.try({
                      try: () => validatePromptImage(command.image!),
                      catch: (error) => error,
                    });
                    image = validated.image;
                    yield* sql`INSERT INTO prompt_images VALUES (${image.id}, ${JSON.stringify(image)}, ${validated.bytes}) ON CONFLICT(id) DO NOTHING`;
                  }
                } else if (
                  command.item.field !== current.field ||
                  command.item.structureId !== current.structureId ||
                  command.item.structureVersion !== current.structureVersion
                ) {
                  return yield* Effect.fail(
                    new ScopeError(
                      400,
                      "A prompt item's field and structure cannot change. Create a separate item.",
                    ),
                  );
                }
                const item = decode(PromptItem, {
                  ...(command.action === "update-item" ? command.item : current),
                  id: current.id,
                  revision: itemRevision,
                  ...(image ? { image } : {}),
                });
                if (!image) delete (item as { image?: PromptImage }).image;
                yield* sql`UPDATE prompt_items SET document = ${JSON.stringify(item)}, image_id = ${image?.id ?? null} WHERE id = ${current.id}`;
              }
            }
            libraryRevision++;
            libraryChanged = true;
            yield* sql`DELETE FROM prompt_images WHERE NOT EXISTS (SELECT 1 FROM prompt_items WHERE image_id = prompt_images.id)`;
          }
          yield* sql`UPDATE prompt_state SET workspace = ${JSON.stringify(workspace)}, library_revision = ${libraryRevision} WHERE id = 1`;
          const receipt = decode(PromptReceipt, {
            type: "receipt",
            requestId: command.requestId,
            action: command.action,
            workspaceRevision: workspace.revision,
            libraryRevision,
            ...(itemId ? { itemId, itemRevision } : {}),
          });
          yield* sql`INSERT INTO prompt_receipts VALUES (${command.requestId}, ${hash}, ${JSON.stringify(receipt)})`;
          return {
            reply: boundedReply(receipt),
            events: [
              {
                type: "prompts",
                workspaceRevision: workspace.revision,
                libraryRevision,
                workspaceChanged,
                libraryChanged,
              },
            ] as LiveEvent[],
          };
        }),
      ),
      (result) => result.events,
    );
    return result.reply;
  }
  async image(itemId: string, imageId: string): Promise<{ image: PromptImage; bytes: Uint8Array }> {
    decode(PromptItemId, itemId);
    decode(BlobId, imageId);
    const { sql, run } = this.database;
    const [row] = await run(
      sql<{
        metadata: string;
        content: Uint8Array;
      }>`SELECT prompt_images.metadata, prompt_images.content FROM prompt_items JOIN prompt_images ON prompt_images.id = prompt_items.image_id WHERE prompt_items.id = ${itemId} AND prompt_images.id = ${imageId}`,
    );
    if (!row) throw new ScopeError(404, "Image is not attached to this prompt item.");
    return {
      image: decode(PromptImage, JSON.parse(row.metadata)),
      bytes: Buffer.from(row.content),
    };
  }
  async exportLibrary(): Promise<Uint8Array> {
    const { sql, run } = this.database;
    const snapshot = await run(
      sql.withTransaction(
        Effect.gen(function* () {
          const [state] =
            yield* sql<State>`SELECT workspace, library_revision FROM prompt_state WHERE id = 1`;
          const rows = yield* sql<ItemRow>`SELECT document FROM prompt_items ORDER BY id`;
          const [{ size }] = yield* sql<{
            size: number;
          }>`SELECT coalesce(sum(length(content)),0) AS size FROM prompt_images WHERE EXISTS (SELECT 1 FROM prompt_items WHERE image_id = prompt_images.id)`;
          if (size > MAX_PROMPT_EXPORT_BYTES)
            return yield* Effect.fail(
              new ScopeError(413, "Prompt library export exceeds 128 MiB."),
            );
          const images = yield* sql<{
            metadata: string;
            content: Uint8Array;
          }>`SELECT metadata, content FROM prompt_images WHERE EXISTS (SELECT 1 FROM prompt_items WHERE image_id = prompt_images.id) ORDER BY id`;
          return {
            libraryRevision: state.library_revision,
            items: rows.map((row) => decode(PromptItem, JSON.parse(row.document))),
            images,
          };
        }),
      ),
    );
    const files: Record<string, Uint8Array> = {};
    const manifest = decode(PromptExportManifest, {
      format: "scope-prompt-library",
      version: 1,
      libraryRevision: snapshot.libraryRevision,
      structures: [PROMPT_STRUCTURE],
      itemsFile: "library.json",
      itemCount: snapshot.items.length,
      images: snapshot.images.map((row) => {
        const image = decode(PromptImage, JSON.parse(row.metadata));
        return { ...image, file: promptImageFile(image) };
      }),
    });
    files["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2));
    files["library.json"] = Buffer.from(JSON.stringify(snapshot.items, null, 2));
    for (const row of snapshot.images)
      files[promptImageFile(decode(PromptImage, JSON.parse(row.metadata)))] = row.content;
    if (
      Object.values(files).reduce((size, bytes) => size + bytes.byteLength, 0) >
      MAX_PROMPT_EXPORT_BYTES - 1024 * 1024
    )
      throw new ScopeError(413, "Prompt library export exceeds 128 MiB.");
    const zip = zipSync(files, { level: 0 });
    if (zip.byteLength > MAX_PROMPT_EXPORT_BYTES)
      throw new ScopeError(413, "Prompt library export exceeds 128 MiB.");
    return zip;
  }
}
