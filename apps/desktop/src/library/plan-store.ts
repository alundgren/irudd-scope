import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Artifact,
  ScopeError,
  decode,
  MAX_CONTENT_BYTES,
  type LiveEvent,
} from "@irudd-scope/protocol";
import {
  PlanCommand,
  PlanRound,
  PlanComment,
  PlanResponse,
  PlanReply,
  MAX_PLAN_IMAGE_BYTES,
  type PlanEvent,
} from "@irudd-scope/protocol/plan";

import { PlanDraft } from "../plugins/plan/draft.ts";

export type PlanDatabase = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  mutate: <A, E>(effect: Effect.Effect<A, E>, events: (result: A) => LiveEvent[]) => Promise<A>;
};

import { readPlanPage, type PlanOwner } from "./plan-read.ts";

export function recordPlanRevision(
  sql: SqliteClient.SqliteClient,
  tabId: string,
  artifact: Artifact,
) {
  return Effect.gen(function* () {
    if (artifact.kind !== "plan") return;
    yield* sql`INSERT INTO plan_state(tab_id, version) VALUES (${tabId}, 1) ON CONFLICT(tab_id) DO UPDATE SET version = version + 1`;
    yield* sql`INSERT INTO plan_revisions(tab_id, revision, blob_id, title, created_at) VALUES (${tabId}, ${artifact.revision}, ${artifact.blob}, ${artifact.title}, ${artifact.updatedAt})`;
  });
}

export class PlanStore {
  constructor(private readonly database: PlanDatabase) {}

  async initialize(): Promise<void> {
    const { sql, run } = this.database;
    const [{ user_version }] = await run(sql<{ user_version: number }>`PRAGMA user_version`);
    if (user_version >= 6) return;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE plan_state(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0)) STRICT`;
          yield* sql`CREATE TABLE plan_revisions(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, revision INTEGER NOT NULL, blob_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, PRIMARY KEY(tab_id, revision), FOREIGN KEY(tab_id, blob_id) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE) STRICT`;
          yield* sql`CREATE TABLE plan_images(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, blob_id TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, PRIMARY KEY(tab_id, blob_id), FOREIGN KEY(tab_id, blob_id) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE) STRICT`;
          yield* sql`CREATE TABLE plan_records(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('comment', 'round', 'response')), id TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), PRIMARY KEY(tab_id, id)) STRICT`;
          yield* sql`CREATE TABLE plan_receipts(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tab_id, request_id)) STRICT`;
          yield* sql`CREATE TABLE plan_drafts(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, document TEXT NOT NULL CHECK(json_valid(document))) STRICT`;
          const existing = yield* sql<{
            tab_id: string;
            document: string;
          }>`SELECT tab_id, document FROM artifacts WHERE json_extract(document, '$.kind') = 'plan'`;
          for (const row of existing)
            yield* recordPlanRevision(sql, row.tab_id, decode(Artifact, JSON.parse(row.document)));
          yield* sql`PRAGMA user_version = 6`;
        }),
      ),
    );
  }

  private owner(name: string) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const [row] =
        yield* sql<PlanOwner>`SELECT artifacts.tab_id, artifacts.document, live_tabs.trashed_at, plan_state.version FROM artifacts JOIN live_tabs ON live_tabs.id = artifacts.tab_id JOIN plan_state ON plan_state.tab_id = artifacts.tab_id WHERE json_extract(artifacts.document, '$.name') = ${name}`;
      if (!row) return yield* Effect.fail(new ScopeError(404, "Named plan not found."));
      return row;
    });
  }

  async command(value: PlanCommand): Promise<PlanReply> {
    const command = decode(PlanCommand, value);
    const { sql, mutate } = this.database;
    const owner = this.owner.bind(this);

    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        let current = yield* owner(command.name);
        if (command.action === "read")
          return { reply: yield* readPlanPage(sql, current, command), events: [] as LiveEvent[] };
        if (current.trashed_at !== null)
          return yield* Effect.fail(
            new ScopeError(409, "This plan is in Trashcan. Restore it before updating."),
          );
        const payload = createHash("sha256")
          .update(
            JSON.stringify(command, (_key, value: unknown) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
                : value,
            ),
          )
          .digest("hex");
        const [receipt] = yield* sql<{
          payload: string;
        }>`SELECT payload FROM plan_receipts WHERE tab_id = ${current.tab_id} AND request_id = ${command.requestId}`;
        if (receipt) {
          if (receipt.payload !== payload)
            return yield* Effect.fail(
              new ScopeError(409, "This request ID was already used with different content."),
            );
          return {
            reply: {
              type: "receipt",
              artifact: decode(Artifact, JSON.parse(current.document)),
              version: current.version,
              ...(["comment", "submit", "respond"].includes(command.action)
                ? { recordId: command.requestId }
                : {}),
            } as PlanReply,
            events: [] as LiveEvent[],
          };
        }
        if (["comment", "submit", "respond"].includes(command.action)) {
          const [existing] =
            yield* sql`SELECT 1 FROM plan_records WHERE tab_id = ${current.tab_id} AND id = ${command.requestId}`;
          if (existing)
            return yield* Effect.fail(new ScopeError(409, "This record ID is already in use."));
        }
        const artifact = decode(Artifact, JSON.parse(current.document));
        const tabId = current.tab_id;
        const now = new Date().toISOString();
        let event: PlanEvent["event"] = "review";
        let roundId: string | undefined;
        let updated: Artifact | undefined;
        const revisionExists = (revision: number) =>
          Effect.map(
            sql`SELECT 1 FROM plan_revisions WHERE tab_id = ${tabId} AND revision = ${revision}`,
            (rows) => rows.length > 0,
          );
        const fail = (message: string) => Effect.fail(new ScopeError(409, message));
        const saveRecord = (kind: string, record: PlanComment | PlanRound | PlanResponse) =>
          sql`INSERT INTO plan_records(tab_id, kind, id, document) VALUES (${tabId}, ${kind}, ${record.id}, ${JSON.stringify(record)}) ON CONFLICT(tab_id, id) DO UPDATE SET document = excluded.document`;
        const publish = (bytes: Uint8Array, title = artifact.title) =>
          Effect.gen(function* () {
            if (
              artifact.revision !== ("expectedRevision" in command ? command.expectedRevision : -1)
            )
              return yield* fail("Plan changed. Read the current revision before updating.");
            if (bytes.byteLength > MAX_CONTENT_BYTES)
              return yield* Effect.fail(new ScopeError(413, "Plan HTML exceeds 32 MiB."));
            const blob = createHash("sha256").update(bytes).digest("hex");
            updated = decode(Artifact, {
              ...artifact,
              title,
              blob,
              size: bytes.byteLength,
              revision: artifact.revision + 1,
              updatedAt: now,
            });
            yield* sql`INSERT INTO blobs(id, content) VALUES (${blob}, ${bytes}) ON CONFLICT(id) DO NOTHING`;
            yield* sql`INSERT INTO tab_blobs VALUES (${tabId}, ${blob}, 0) ON CONFLICT(tab_id, blob_id) DO NOTHING`;
            yield* sql`UPDATE artifacts SET revision = ${updated.revision}, blob_id = ${blob}, document = ${JSON.stringify(updated)} WHERE id = ${artifact.id}`;
            yield* sql`UPDATE lifecycle SET value = max(value, ${updated.revision}) WHERE name = 'max_revision'`;
            yield* sql`INSERT INTO plan_revisions(tab_id, revision, blob_id, title, created_at) VALUES (${tabId}, ${updated.revision}, ${blob}, ${title}, ${now})`;
          });
        switch (command.action) {
          case "comment": {
            if (!(yield* revisionExists(command.revision)))
              return yield* fail("The comment revision is not retained by this plan.");
            const storeImage = (base64: string) =>
              Effect.gen(function* () {
                const image = validatePlanPng(base64);
                const id = createHash("sha256").update(image.bytes).digest("hex");
                yield* sql`INSERT INTO blobs(id, content) VALUES (${id}, ${image.bytes}) ON CONFLICT(id) DO NOTHING`;
                yield* sql`INSERT INTO tab_blobs VALUES (${tabId}, ${id}, 0) ON CONFLICT(tab_id, blob_id) DO NOTHING`;
                yield* sql`INSERT INTO plan_images VALUES (${tabId}, ${id}, ${image.width}, ${image.height}) ON CONFLICT(tab_id, blob_id) DO NOTHING`;
                return { id, width: image.width, height: image.height };
              });
            const originalImage = yield* storeImage(command.image);
            const image = yield* storeImage(command.annotatedImage);
            if (image.width !== originalImage.width || image.height !== originalImage.height)
              return yield* Effect.fail(
                new ScopeError(
                  400,
                  "Marked screenshot dimensions must match the original screenshot.",
                ),
              );
            const comment: PlanComment = {
              id: command.requestId,
              revision: command.revision,
              page: command.page,
              text: command.text,
              image,
              originalImage,
              annotations: command.annotations,
              ...(command.selectedText !== undefined ? { selectedText: command.selectedText } : {}),
              ...(command.elementId !== undefined ? { elementId: command.elementId } : {}),
              createdAt: now,
              resolved: false,
            };
            yield* saveRecord("comment", comment);
            event = "comment";
            break;
          }
          case "submit": {
            const ids = [...new Set(command.commentIds)];
            if (ids.length !== command.commentIds.length)
              return yield* fail("A round cannot repeat a comment.");
            const rows = yield* sql<{
              document: string;
            }>`SELECT document FROM plan_records WHERE tab_id = ${tabId} AND kind = 'comment' AND ${sql.in("id", ids)}`;
            const comments = rows.map((row) => decode(PlanComment, JSON.parse(row.document)));
            if (
              comments.length !== ids.length ||
              comments.some((entry) => entry.revision !== comments[0].revision)
            )
              return yield* fail("Round comments must belong to this plan and one revision.");
            const [submitted] =
              yield* sql`SELECT 1 FROM plan_records, json_each(plan_records.document, '$.commentIds') AS comments WHERE tab_id = ${tabId} AND kind = 'round' AND ${sql.in("value", ids)} LIMIT 1`;
            if (submitted) return yield* fail("A comment has already been submitted.");
            const round: PlanRound = {
              id: command.requestId,
              revision: comments[0].revision,
              commentIds: ids,
              ...(command.message !== undefined ? { message: command.message } : {}),
              createdAt: now,
              status: "pending",
            };
            yield* saveRecord("round", round);
            roundId = round.id;
            event = "round";
            break;
          }
          case "respond": {
            const [row] = yield* sql<{
              document: string;
            }>`SELECT document FROM plan_records WHERE tab_id = ${tabId} AND kind = 'round' AND id = ${command.roundId}`;
            const round = row ? decode(PlanRound, JSON.parse(row.document)) : undefined;
            if (!round || round.status !== "pending")
              return yield* fail("The round is missing or already answered.");
            if (!(yield* revisionExists(command.expectedRevision)))
              return yield* fail("The response revision is not retained by this plan.");
            const ids = command.replies.map((reply) => reply.commentId);
            if (
              new Set(ids).size !== ids.length ||
              ids.some((id) => !round.commentIds.includes(id))
            )
              return yield* fail("Replies must identify distinct comments from this round.");
            if (round.commentIds.some((id) => !ids.includes(id)))
              return yield* fail("Reply to every comment before answering this round.");
            if (command.html !== undefined) yield* publish(Buffer.from(command.html));
            const response: PlanResponse = {
              id: command.requestId,
              roundId: round.id,
              baseRevision: command.expectedRevision,
              revision: updated?.revision ?? artifact.revision,
              summary: command.summary,
              replies: command.replies,
              createdAt: now,
              seen: false,
            };
            yield* saveRecord("response", response);
            yield* saveRecord("round", { ...round, status: "responded" });
            roundId = round.id;
            event = "response";
            break;
          }
          case "resolve": {
            const [row] = yield* sql<{
              document: string;
            }>`SELECT document FROM plan_records WHERE tab_id = ${tabId} AND kind = 'comment' AND id = ${command.commentId}`;
            const comment = row ? decode(PlanComment, JSON.parse(row.document)) : undefined;
            if (!comment) return yield* fail("This comment does not belong to the plan.");
            yield* saveRecord("comment", { ...comment, resolved: command.resolved });
            break;
          }
          case "seen": {
            const [row] = yield* sql<{
              document: string;
            }>`SELECT document FROM plan_records WHERE tab_id = ${tabId} AND kind = 'response' AND id = ${command.responseId}`;
            const response = row ? decode(PlanResponse, JSON.parse(row.document)) : undefined;
            if (!response) return yield* fail("This response does not belong to the plan.");
            yield* saveRecord("response", { ...response, seen: command.seen });
            break;
          }
          case "approve":
            if (command.expectedRevision !== artifact.revision)
              return yield* fail("Plan changed. Read the current revision before approving.");
            yield* sql`UPDATE plan_revisions SET approved_at = coalesce(approved_at, ${now}) WHERE tab_id = ${tabId} AND revision = ${artifact.revision}`;
            break;
          case "restore": {
            const [revision] = yield* sql<{
              content: Uint8Array;
              title: string;
            }>`SELECT blobs.content, plan_revisions.title FROM plan_revisions JOIN blobs ON blobs.id = plan_revisions.blob_id WHERE tab_id = ${tabId} AND revision = ${command.revision}`;
            if (!revision) return yield* fail("This revision is not retained by the plan.");
            yield* publish(revision.content, revision.title);
            break;
          }
        }
        yield* sql`UPDATE plan_state SET version = version + 1 WHERE tab_id = ${tabId}`;
        yield* sql`INSERT INTO plan_receipts VALUES (${tabId}, ${command.requestId}, ${payload})`;
        current = yield* owner(command.name);
        const planEvent: PlanEvent = {
          type: "plan",
          name: command.name,
          id: artifact.id,
          version: current.version,
          event,
          ...(roundId ? { roundId } : {}),
        };
        return {
          reply: {
            type: "receipt",
            artifact: updated ?? artifact,
            version: current.version,
            ...(["comment", "submit", "respond"].includes(command.action)
              ? { recordId: command.requestId }
              : {}),
          } as PlanReply,
          events: [
            ...(updated ? [{ type: "artifact", artifact: updated } as LiveEvent] : []),
            planEvent,
          ],
        };
      }),
    );
    const result = await mutate(transaction, (result) => result.events);
    return decode(PlanReply, result.reply);
  }

  async draft(tabId: string): Promise<PlanDraft | null> {
    const { sql, run } = this.database;
    const [row] = await run(
      sql<{ document: string }>`SELECT document FROM plan_drafts WHERE tab_id = ${tabId}`,
    );
    return row ? decode(PlanDraft, JSON.parse(row.document)) : null;
  }

  async saveDraft(tabId: string, value: PlanDraft | null): Promise<void> {
    const draft = value === null ? null : decode(PlanDraft, value);
    if (draft) {
      const image = validatePlanPng(draft.image);
      if (image.width !== draft.width || image.height !== draft.height)
        throw new ScopeError(400, "Draft dimensions do not match its screenshot.");
    }
    const { sql, run } = this.database;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          const [row] =
            yield* sql`SELECT 1 FROM live_tabs JOIN plan_state ON plan_state.tab_id = live_tabs.id WHERE live_tabs.id = ${tabId} AND live_tabs.trashed_at IS NULL`;
          if (!row)
            return yield* Effect.fail(new ScopeError(409, "This plan is no longer active."));
          if (draft) {
            const [revision] =
              yield* sql`SELECT 1 FROM plan_revisions WHERE tab_id = ${tabId} AND revision = ${draft.revision}`;
            if (!revision)
              return yield* Effect.fail(new ScopeError(409, "The draft revision is not retained."));
            yield* sql`INSERT INTO plan_drafts VALUES (${tabId}, ${JSON.stringify(draft)}) ON CONFLICT(tab_id) DO UPDATE SET document = excluded.document`;
          } else yield* sql`DELETE FROM plan_drafts WHERE tab_id = ${tabId}`;
        }),
      ),
    );
  }

  async image(name: string, id: string): Promise<Buffer> {
    const { sql, run } = this.database;
    const owner = await run(this.owner(name));
    const [row] = await run(
      sql<{
        content: Uint8Array;
      }>`SELECT blobs.content FROM plan_images JOIN blobs ON blobs.id = plan_images.blob_id WHERE tab_id = ${owner.tab_id} AND blob_id = ${id}`,
    );
    if (!row) throw new ScopeError(404, "Plan screenshot not found.");
    return Buffer.from(row.content);
  }

  async content(name: string, revision: number): Promise<Buffer> {
    const { sql, run } = this.database;
    const owner = await run(this.owner(name));
    const [row] = await run(
      sql<{
        content: Uint8Array;
      }>`SELECT blobs.content FROM plan_revisions JOIN blobs ON blobs.id = plan_revisions.blob_id WHERE tab_id = ${owner.tab_id} AND revision = ${revision}`,
    );
    if (!row) throw new ScopeError(404, "Plan revision not found.");
    return Buffer.from(row.content);
  }
}

export function validatePlanPng(base64: string): { bytes: Buffer; width: number; height: number } {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    throw new ScopeError(400, "Screenshot must be base64 PNG.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_PLAN_IMAGE_BYTES)
    throw new ScopeError(413, "Screenshot exceeds 8 MiB.");
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new ScopeError(400, "Screenshot must be a PNG image.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192)
    throw new ScopeError(400, "Screenshot dimensions must be between 1 and 8192 pixels.");
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[bytes[25]]?.includes(bytes[24]) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] > 1
  )
    throw new ScopeError(400, "Screenshot PNG header is invalid.");
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) break;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      crc32(bytes.subarray(offset + 4, offset + length + 8)) !==
      bytes.readUInt32BE(offset + length + 8)
    )
      throw new ScopeError(400, "Screenshot PNG checksum is invalid.");
    if (kind === "IHDR" && offset !== 8)
      throw new ScopeError(400, "Screenshot PNG repeats its header.");
    if (kind === "IDAT" && length > 0) imageData = true;
    if (kind === "IEND" && length === 0 && end === bytes.length && imageData)
      return { bytes, width, height };
    offset = end;
  }
  throw new ScopeError(400, "Screenshot PNG is incomplete.");
}
