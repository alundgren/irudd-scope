import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { Artifact, ScopeError, decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  PublicationsCommand,
  PublicationsReply,
  PublicationsSnapshot,
  PublicationCheckpoint,
  PublicationOperation,
  type PublicationObservation,
  type PublicationProvider,
  type PublicationSuccess,
} from "@irudd-scope/protocol/publications";

type Database = {
  sql: SqliteClient.SqliteClient;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  mutate: <A, E>(effect: Effect.Effect<A, E>, events: (result: A) => LiveEvent[]) => Promise<A>;
};
type Owner = { tab_id: string; document: string; trashed_at: number | null };
type Row = { provider: PublicationProvider; checkpoint: string | null; operation: string | null };
const fail = (message: string, status = 409) => Effect.fail(new ScopeError(status, message));
function timestamp(value: string | null): bigint | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1])
    return null;
  return BigInt(millis) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}
function safeUrl(provider: PublicationProvider, value: string | null): boolean {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      (provider !== "claude" ||
        (url.hostname === "claude.ai" && /^\/code\/artifact\/[^/]+$/.test(url.pathname)))
    );
  } catch {
    return false;
  }
}
function overwriteWarnings(
  provider: PublicationProvider,
  observation: PublicationObservation,
  checkpoint: PublicationCheckpoint | null,
): string[] {
  if (observation.remoteId === null) return [];
  const warnings: string[] = [];
  const before = checkpoint?.result.marker,
    after = observation.marker;
  if (!before)
    warnings.push(
      "This existing destination has no Scope checkpoint. Publishing could overwrite remote content.",
    );
  else {
    if (before.version !== null && after.version !== null && before.version !== after.version)
      warnings.push(
        "The remote version changed after the last Scope publication. Publishing would overwrite remote edits.",
      );
    const beforeDate = timestamp(before.updatedAt),
      afterDate = timestamp(after.updatedAt);
    if (beforeDate !== null && afterDate !== null && afterDate > beforeDate)
      warnings.push(
        "The remote publication date is newer than the last Scope publication. Publishing would overwrite remote edits.",
      );
    if (beforeDate !== null && afterDate !== null && afterDate < beforeDate)
      warnings.push(
        "Remote publication dates regressed and cannot verify the current content. Publishing could overwrite remote edits.",
      );
    if (
      (before.updatedAt !== null && beforeDate === null) ||
      (after.updatedAt !== null && afterDate === null)
    )
      warnings.push(
        "Remote publication dates are invalid and cannot verify the current content. Publishing could overwrite remote edits.",
      );
    const sameVersion = before.version !== null && after.version === before.version;
    const sameDate = beforeDate !== null && afterDate === beforeDate;
    if (!sameVersion && !sameDate && !warnings.length)
      warnings.push(
        "Remote change metadata is missing or incomparable. Publishing could overwrite remote edits.",
      );
  }
  if (provider === "sites" || !observation.conditionalWrite)
    warnings.push(
      "This provider cannot guarantee a conditional update. Another remote edit could occur before publishing; approve this overwrite explicitly.",
    );
  return warnings;
}
function fresh(observation: PublicationObservation): boolean {
  const checked = timestamp(observation.checkedAt);
  const now = BigInt(Date.now()) * 1_000_000n;
  return checked !== null && checked <= now && now - checked <= 60_000_000_000n;
}
function privacy(provider: PublicationProvider, observation: PublicationObservation): string[] {
  const messages: string[] = [];
  if (!safeUrl(provider, observation.url))
    messages.push("The destination URL is not a supported secure provider URL.");
  if (!["owner", "editor"].includes(observation.access))
    messages.push("The signed-in account cannot verify edit permission.");
  if (!["owner", "team"].includes(observation.audience))
    messages.push("Destination privacy is public, external, or unverified.");
  if (provider === "sites" && (observation.audience !== "owner" || observation.access !== "owner"))
    messages.push("Sites publishing requires owner-only access and its private deployment tool.");
  if (provider === "claude" && observation.audience === "team" && observation.workspaceId === null)
    messages.push("A team-only Claude destination needs verified workspace identity.");
  if (
    (observation.remoteId === null && observation.url !== null) ||
    (provider === "claude" && observation.remoteId !== null && observation.url === null)
  )
    messages.push("Remote identity and URL are inconsistent for this provider.");
  if (
    observation.evidence === "documented-private-default" &&
    (provider !== "claude" || observation.remoteId !== null || observation.audience !== "owner")
  )
    messages.push("The documented private default applies only to a new Claude artifact.");
  if (
    provider === "claude" &&
    observation.remoteId !== null &&
    observation.evidence !== "authenticated-share-inspection"
  )
    messages.push(
      "Inspect the existing Claude artifact's Share settings in the signed-in account before updating.",
    );
  return messages;
}
function validateResult(
  provider: PublicationProvider,
  operation: PublicationOperation,
  result: PublicationSuccess,
): string | null {
  if (!safeUrl(provider, result.url))
    return "The destination URL is not a supported secure provider URL.";
  if (result.provider !== provider) return "The result belongs to another provider.";
  if (timestamp(result.confirmedAt) === null || Date.parse(result.confirmedAt) > Date.now())
    return "The confirmation date is invalid.";
  const expected = operation.progress ?? operation.observation;
  if (
    expected.remoteId !== null &&
    (expected.remoteId !== result.remoteId ||
      (expected.url !== null && expected.url !== result.url))
  )
    return "The result belongs to another destination.";
  if (result.marker.updatedAt !== null && timestamp(result.marker.updatedAt) === null)
    return "The provider date is invalid.";
  if (provider === "sites") {
    if (!operation.progress || !result.savedVersion || !result.sourceCommit || !result.deploymentId)
      return "Sites completion needs a recorded saved version, source commit, and successful deployment.";
    if (
      operation.progress.savedVersion !== result.savedVersion ||
      operation.progress.sourceCommit !== result.sourceCommit ||
      operation.progress.deploymentId !== result.deploymentId
    )
      return "The successful deployment must match the recorded Sites version and source.";
  }
  return null;
}

export class PublicationStore {
  constructor(private readonly database: Database) {}
  async initialize(): Promise<void> {
    const { sql, run } = this.database;
    const [{ user_version }] = await run(sql<{ user_version: number }>`PRAGMA user_version`);
    if (user_version >= 8) return;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE publications(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK(provider IN ('claude', 'sites')), checkpoint TEXT CHECK(checkpoint IS NULL OR json_valid(checkpoint)), operation TEXT CHECK(operation IS NULL OR json_valid(operation)), checkpoint_blob TEXT, operation_blob TEXT, PRIMARY KEY(tab_id, provider), FOREIGN KEY(tab_id, checkpoint_blob) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE, FOREIGN KEY(tab_id, operation_blob) REFERENCES tab_blobs(tab_id, blob_id) ON DELETE CASCADE) STRICT`;
          yield* sql`CREATE UNIQUE INDEX publication_operations ON publications(tab_id, json_extract(operation, '$.operationId')) WHERE operation IS NOT NULL`;
          yield* sql`PRAGMA user_version = 8`;
        }),
      ),
    );
  }
  private owner(id: string) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const [owner] =
        yield* sql<Owner>`SELECT artifacts.tab_id, artifacts.document, live_tabs.trashed_at FROM artifacts JOIN live_tabs ON live_tabs.id = artifacts.tab_id WHERE artifacts.id = ${id}`;
      if (!owner) return yield* fail("Artifact not found.", 404);
      return owner;
    });
  }
  private snapshot(owner: Owner) {
    const { sql } = this.database;
    return Effect.gen(function* () {
      const rows =
        yield* sql<Row>`SELECT provider, checkpoint, operation FROM publications WHERE tab_id = ${owner.tab_id} ORDER BY provider`;
      return decode(PublicationsSnapshot, {
        artifact: JSON.parse(owner.document),
        tabId: owner.tab_id,
        destinations: rows.map((row) => {
          let operation = row.operation
            ? decode(PublicationOperation, JSON.parse(row.operation))
            : null;
          if (operation)
            operation = {
              ...operation,
              needsRefresh: operation.state !== "started" && !fresh(operation.observation),
            };
          // Expiry prevents a remote call, but retains approval for an identical fresh observation.
          if (operation && operation.state !== "started" && !fresh(operation.observation))
            operation = {
              ...operation,
              warnings: [
                ...operation.warnings,
                "The remote observation expired. Check the destination again before publishing.",
              ],
            };
          return {
            provider: row.provider,
            checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null,
            operation,
          };
        }),
      });
    });
  }
  async content(id: string, operationId: string): Promise<Uint8Array> {
    const { sql, run } = this.database;
    const owner = this.owner.bind(this);
    return run(
      Effect.gen(function* () {
        const tab = yield* owner(id);
        const [row] = yield* sql<{
          content: Uint8Array;
        }>`SELECT blobs.content FROM publications JOIN blobs ON blobs.id = CASE WHEN json_extract(publications.operation, '$.operationId') = ${operationId} THEN publications.operation_blob ELSE publications.checkpoint_blob END WHERE publications.tab_id = ${tab.tab_id} AND (json_extract(publications.operation, '$.operationId') = ${operationId} OR json_extract(publications.checkpoint, '$.operationId') = ${operationId})`;
        if (!row) return yield* fail("Publication operation content not found.", 404);
        return row.content;
      }),
    );
  }
  async command(input: PublicationsCommand): Promise<PublicationsReply> {
    const command = decode(PublicationsCommand, input);
    const { sql, run, mutate } = this.database;
    const owner = this.owner.bind(this),
      snapshot = this.snapshot.bind(this);
    if (command.action === "read")
      return run(
        Effect.gen(function* () {
          const value = yield* snapshot(yield* owner(command.id));
          const blocked = value.destinations.filter((item) => item.operation?.state === "blocked");
          const warned = value.destinations.filter((item) => item.operation?.state === "warning");
          return {
            type: "snapshot" as const,
            snapshot: value,
            decision: blocked.length
              ? ("blocked" as const)
              : warned.length
                ? ("warning" as const)
                : ("allowed" as const),
            messages: (blocked.length ? blocked : warned).flatMap(
              (item) => item.operation?.warnings ?? [],
            ),
          };
        }),
      );
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const tab = yield* owner(command.id);
          if (tab.tab_id !== command.tabId)
            return yield* fail("The artifact belongs to another tab. Read it again.");
          if (tab.trashed_at !== null)
            return yield* fail("Restore this tab before changing publications.");
          const artifact = decode(Artifact, JSON.parse(tab.document));
          const [row] =
            yield* sql<Row>`SELECT provider, checkpoint, operation FROM publications WHERE tab_id = ${tab.tab_id} AND provider = ${command.provider}`;
          const checkpoint = row?.checkpoint
            ? decode(PublicationCheckpoint, JSON.parse(row.checkpoint))
            : null;
          let operation = row?.operation
            ? decode(PublicationOperation, JSON.parse(row.operation))
            : null;
          let decision: PublicationsReply["decision"] = "allowed";
          let messages: string[] = [];
          if (command.action === "prepare") {
            if (operation)
              return yield* fail(
                "This destination has an unresolved publication. Reconcile or cancel it before preparing another.",
              );
            const duplicates =
              yield* sql`SELECT provider FROM publications WHERE tab_id = ${tab.tab_id} AND (json_extract(operation, '$.operationId') = ${command.operationId} OR json_extract(checkpoint, '$.operationId') = ${command.operationId})`;
            if (duplicates.length)
              return yield* fail("Use a new operation ID for each publication.");
            if (checkpoint?.operationId === command.operationId)
              return yield* fail("Use a new operation ID after a completed publication.");
            if (artifact.revision !== command.expectedRevision)
              return yield* fail("The local artifact changed. Read it again before preparing.");
            if (!["html", "plan"].includes(artifact.kind))
              messages.push("Only stored HTML and plans can be published to these destinations.");
            messages.push(...privacy(command.provider, command.observation));
            if (!fresh(command.observation))
              messages.push(
                "Check the destination again: the account observation must be no more than 60 seconds old.",
              );
            if (
              checkpoint &&
              (checkpoint.observation.accountId !== command.observation.accountId ||
                checkpoint.observation.workspaceId !== command.observation.workspaceId ||
                checkpoint.result.remoteId !== command.observation.remoteId ||
                checkpoint.result.url !== command.observation.url)
            )
              messages.push(
                "The account, workspace, or remote destination changed. Unlink it before choosing a different destination.",
              );
            if (messages.length) {
              decision = "blocked";
            } else {
              const warnings = overwriteWarnings(command.provider, command.observation, checkpoint);
              operation = {
                operationId: command.operationId,
                provider: command.provider,
                revision: artifact.revision,
                blob: artifact.blob,
                observation: command.observation,
                state: warnings.length ? "warning" : "prepared",
                warnings,
                createdAt: new Date().toISOString(),
                progress: null,
              };
              yield* sql`INSERT INTO publications(tab_id, provider, operation, operation_blob) VALUES (${tab.tab_id}, ${command.provider}, ${JSON.stringify(operation)}, ${artifact.blob}) ON CONFLICT(tab_id, provider) DO UPDATE SET operation = excluded.operation, operation_blob = excluded.operation_blob`;
              decision = warnings.length ? "warning" : "allowed";
              messages = warnings;
            }
          } else if (command.action === "refresh") {
            if (!operation || operation.operationId !== command.operationId)
              return yield* fail("Publication operation not found.", 404);
            if (operation.state === "started")
              return yield* fail(
                "Started operations must be reconciled; they cannot refresh or restart.",
              );
            if (operation.revision !== artifact.revision || operation.blob !== artifact.blob)
              return yield* fail(
                "The local artifact changed. Cancel this operation and prepare the current revision.",
              );
            const previous = operation.observation;
            if (
              previous.accountId !== command.observation.accountId ||
              previous.workspaceId !== command.observation.workspaceId ||
              previous.remoteId !== command.observation.remoteId ||
              (previous.url !== null && previous.url !== command.observation.url)
            )
              return yield* fail(
                "The account or destination changed. Cancel or unlink before choosing another destination.",
              );
            if (!fresh(command.observation))
              return yield* fail("The refreshed observation must be no more than 60 seconds old.");
            const same =
              JSON.stringify({ ...previous, checkedAt: "" }) ===
              JSON.stringify({ ...command.observation, checkedAt: "" });
            const blocked = privacy(command.provider, command.observation);
            const warnings = blocked.length
              ? blocked
              : overwriteWarnings(command.provider, command.observation, checkpoint);
            operation = {
              ...operation,
              observation: command.observation,
              warnings,
              state: blocked.length
                ? "blocked"
                : !same && warnings.length
                  ? "warning"
                  : same
                    ? operation.state
                    : "prepared",
            };
            yield* sql`UPDATE publications SET operation = ${JSON.stringify(operation)} WHERE tab_id = ${tab.tab_id} AND provider = ${command.provider}`;
            decision = blocked.length
              ? "blocked"
              : operation.state === "warning"
                ? "warning"
                : "allowed";
            messages = warnings;
          } else if (command.action === "unlink") {
            if (operation?.state === "started" && !command.acknowledgeUncertain)
              return yield* fail(
                "The remote outcome may be uncertain. Explicitly acknowledge this before unlinking; unlink does not delete remote content.",
              );
            yield* sql`DELETE FROM publications WHERE tab_id = ${tab.tab_id} AND provider = ${command.provider}`;
          } else {
            if (command.action === "complete" && checkpoint?.operationId === command.operationId) {
              if (JSON.stringify(checkpoint.result) !== JSON.stringify(command.result))
                return yield* fail("This completion was already recorded with a different result.");
              return {
                type: "snapshot" as const,
                snapshot: yield* snapshot(tab),
                decision,
                messages,
              };
            }
            if (!operation || operation.operationId !== command.operationId)
              return yield* fail("Publication operation not found or replaced.", 404);
            if (command.action === "cancel") {
              if (operation.state === "started" && !command.acknowledgeUncertain)
                return yield* fail(
                  "The remote outcome may be uncertain. Inspect it before explicitly cancelling this operation.",
                );
              operation = null;
            } else if (command.action === "authorize" || command.action === "start") {
              if (privacy(command.provider, operation.observation).length)
                return yield* fail(
                  "Destination privacy or account evidence is not verified. Refresh it before continuing.",
                );
              if (command.action === "start" && !fresh(operation.observation))
                return yield* fail(
                  "The remote observation expired. Refresh the destination check before starting.",
                );
              if (operation.revision !== artifact.revision)
                return yield* fail(
                  "The local artifact changed. Cancel this unstarted operation and prepare the current revision.",
                );
              if (command.action === "authorize") {
                if (
                  JSON.stringify({ ...command.expectedObservation, checkedAt: "" }) !==
                  JSON.stringify({ ...operation.observation, checkedAt: "" })
                )
                  return yield* fail(
                    "The destination check changed. Read the new warning before acknowledging it.",
                  );
                if (operation.state === "started")
                  return yield* fail("This operation has already started.");
                operation = { ...operation, state: "prepared" };
              } else {
                if (operation.state !== "prepared")
                  return yield* fail(
                    "Explicitly authorize the overwrite warning before starting. Started operations must be reconciled before retrying.",
                  );
                operation = { ...operation, state: "started" };
              }
            } else if (command.action === "progress") {
              if (operation.state !== "started")
                return yield* fail("Start the operation before recording remote progress.");
              if (!safeUrl(command.provider, command.progress.url))
                return yield* fail("Remote progress URL is not a supported secure provider URL.");
              const previous = operation.progress ?? operation.observation;
              if (
                previous.remoteId !== null &&
                (previous.remoteId !== command.progress.remoteId ||
                  (previous.url !== null && previous.url !== command.progress.url))
              )
                return yield* fail("Remote progress belongs to another destination.");
              if (
                operation.progress &&
                ((operation.progress.savedVersion &&
                  operation.progress.savedVersion !== command.progress.savedVersion) ||
                  (operation.progress.sourceCommit &&
                    operation.progress.sourceCommit !== command.progress.sourceCommit) ||
                  (operation.progress.deploymentId &&
                    operation.progress.deploymentId !== command.progress.deploymentId))
              )
                return yield* fail("Recorded remote progress cannot be replaced or cleared.");
              operation = { ...operation, progress: command.progress };
            } else if (command.action === "complete") {
              if (operation.state !== "started")
                return yield* fail("Only a started operation can complete.");
              const problem = validateResult(command.provider, operation, command.result);
              if (problem) return yield* fail(problem);
              const value: PublicationCheckpoint = {
                operationId: operation.operationId,
                revision: operation.revision,
                blob: operation.blob,
                observation: operation.observation,
                result: command.result,
              };
              yield* sql`UPDATE publications SET checkpoint = ${JSON.stringify(value)}, checkpoint_blob = ${operation.blob} WHERE tab_id = ${tab.tab_id} AND provider = ${command.provider}`;
              operation = null;
            }
            yield* sql`UPDATE publications SET operation = ${operation ? JSON.stringify(operation) : null}, operation_blob = ${operation?.blob ?? null} WHERE tab_id = ${tab.tab_id} AND provider = ${command.provider}`;
          }
          return { type: "snapshot" as const, snapshot: yield* snapshot(tab), decision, messages };
        }),
      ),
      (reply) => [
        { type: "publications", id: reply.snapshot.artifact.id, tabId: reply.snapshot.tabId },
      ],
    );
  }
}
