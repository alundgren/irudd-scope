import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CommandReceipt,
  ConflictReceipt,
  PlanCommand,
  PlanEvent,
  PlanSnapshot,
  VersionPage,
} from "../contracts.ts";
import { gitDiff, rebaseHtml } from "./html.ts";

type Outcome = { status: 200 | 409; receipt: CommandReceipt | ConflictReceipt };
function decode<T>(row: Record<string, unknown> | undefined, field: string): T | undefined {
  return row ? (JSON.parse(String(row[field])) as T) : undefined;
}
export class PlanStore {
  private database: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS plans (name TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        name TEXT NOT NULL REFERENCES plans(name), revision INTEGER NOT NULL,
        html_revision INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(name, revision));
      CREATE INDEX IF NOT EXISTS html_versions ON versions(name, html_revision);
      CREATE TABLE IF NOT EXISTS receipts (
        name TEXT NOT NULL REFERENCES plans(name), request_id TEXT NOT NULL,
        command TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(name, request_id));`);
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  private existing(name: string): PlanSnapshot | undefined {
    return decode<PlanSnapshot>(
      this.database.prepare("SELECT snapshot FROM plans WHERE name=?").get(name),
      "snapshot",
    );
  }
  private write(event: PlanEvent) {
    this.database
      .prepare("INSERT INTO versions VALUES (?, ?, ?, ?)")
      .run(event.snapshot.name, event.revision, event.htmlRevision, JSON.stringify(event));
    this.database
      .prepare("UPDATE plans SET snapshot=? WHERE name=?")
      .run(JSON.stringify(event.snapshot), event.snapshot.name);
  }
  private ensure(name: string): PlanSnapshot {
    const existing = this.existing(name);
    if (existing) return existing;
    const html = `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head><body><main id="plan"><h1 id="title">${escapeHtml(name)}</h1><p id="intro">Start planning together.</p></main></body></html>\n`;
    const snapshot: PlanSnapshot = {
      name,
      revision: 1,
      htmlRevision: 1,
      html,
      comments: [],
      updatedAt: new Date().toISOString(),
    };
    this.database.prepare("INSERT INTO plans VALUES (?, ?)").run(name, JSON.stringify(snapshot));
    this.write({
      revision: 1,
      htmlRevision: 1,
      requestId: "created",
      kind: "created",
      actor: { id: "system", name: "System", kind: "agent" },
      createdAt: snapshot.updatedAt,
      diff: gitDiff("", html),
      snapshot,
    });
    return snapshot;
  }
  snapshot(name: string): PlanSnapshot {
    const existing = this.existing(name);
    return existing ?? this.transaction(() => this.ensure(name));
  }
  command(name: string, command: PlanCommand): Outcome {
    return this.transaction(() => {
      const current = this.ensure(name);
      const encoded = JSON.stringify(command);
      const prior = this.database
        .prepare("SELECT command,outcome FROM receipts WHERE name=? AND request_id=?")
        .get(name, command.requestId);
      if (prior) {
        if (prior.command !== encoded)
          return this.conflict(
            command,
            current,
            "Request ID was already used for a different command.",
          );
        return JSON.parse(String(prior.outcome)) as Outcome;
      }
      const outcome = this.apply(current, command);
      this.database
        .prepare("INSERT INTO receipts VALUES (?, ?, ?, ?)")
        .run(name, command.requestId, encoded, JSON.stringify(outcome));
      return outcome;
    });
  }
  private conflict(command: PlanCommand, snapshot: PlanSnapshot, message: string): Outcome {
    return {
      status: 409,
      receipt: { error: "conflict", message, requestId: command.requestId, snapshot },
    };
  }
  private apply(current: PlanSnapshot, command: PlanCommand): Outcome {
    const next = structuredClone(current);
    let rebased = false;
    if (command.kind === "html") {
      const base = decode<PlanEvent>(
        this.database
          .prepare(
            "SELECT event FROM versions WHERE name=? AND html_revision=? ORDER BY revision LIMIT 1",
          )
          .get(current.name, command.baseHtmlRevision),
        "event",
      );
      if (!base) return this.conflict(command, current, "Base HTML revision does not exist.");
      let priorHtml = base.snapshot.html;
      let proposal = command.html;
      const changes = this.database
        .prepare(
          "SELECT event FROM versions WHERE name=? AND html_revision>? AND json_extract(event, '$.kind')='html' ORDER BY revision",
        )
        .iterate(current.name, command.baseHtmlRevision);
      for (const row of changes) {
        const accepted = JSON.parse(String(row.event)) as PlanEvent;
        const merged = rebaseHtml(priorHtml, accepted.snapshot.html, proposal);
        if (merged === null)
          return this.conflict(
            command,
            current,
            "HTML edits overlap. Your proposed HTML has not been discarded.",
          );
        proposal = merged;
        priorHtml = accepted.snapshot.html;
      }
      next.html = proposal;
      next.htmlRevision++;
      rebased = command.baseHtmlRevision !== current.htmlRevision;
    } else if (command.kind === "comment.add") {
      next.comments.push({
        id: randomUUID(),
        anchor: command.anchor,
        text: command.text,
        actor: command.actor,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
    } else {
      const comment = next.comments.find((item) => item.id === command.commentId);
      if (!comment) return this.conflict(command, current, "Comment does not exist.");
      if (command.kind === "comment.reply")
        comment.replies.push({
          id: randomUUID(),
          text: command.text,
          actor: command.actor,
          createdAt: new Date().toISOString(),
        });
      else comment.resolved = command.resolved;
    }
    next.revision++;
    next.updatedAt = new Date().toISOString();
    this.write({
      revision: next.revision,
      htmlRevision: next.htmlRevision,
      requestId: command.requestId,
      kind: command.kind,
      actor: command.actor,
      createdAt: next.updatedAt,
      diff: gitDiff(current.html, next.html),
      snapshot: next,
    });
    return {
      status: 200,
      receipt: { requestId: command.requestId, revision: next.revision, rebased, snapshot: next },
    };
  }
  events(name: string, after: number, limit = 20): PlanEvent[] {
    return this.database
      .prepare("SELECT event FROM versions WHERE name=? AND revision>? ORDER BY revision LIMIT ?")
      .all(name, after, limit)
      .map((row) => JSON.parse(String(row.event)) as PlanEvent);
  }
  versions(name: string, before: number, limit: number): VersionPage {
    const rows = this.database
      .prepare(
        "SELECT event FROM versions WHERE name=? AND revision<? ORDER BY revision DESC LIMIT ?",
      )
      .all(name, before, limit + 1);
    const versions = rows.slice(0, limit).map((row) => JSON.parse(String(row.event)) as PlanEvent);
    return { versions, nextBefore: rows.length > limit ? versions.at(-1)!.revision : null };
  }
  version(name: string, revision: number): PlanSnapshot | undefined {
    return decode<PlanEvent>(
      this.database
        .prepare("SELECT event FROM versions WHERE name=? AND revision=?")
        .get(name, revision),
      "event",
    )?.snapshot;
  }
  close() {
    this.database.close();
  }
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
