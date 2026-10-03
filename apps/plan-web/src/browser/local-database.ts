import type { PGlite } from "@electric-sql/pglite";
import type { Actor, PlanCommand, PlanSnapshot } from "../contracts.ts";

export type Draft = {
  html: string;
  generation: number;
  baseHtml: string;
  baseHtmlRevision: number;
  dirty: boolean;
  conflict: PlanSnapshot | null;
  actor?: Actor;
  rejectedGeneration?: number;
};
export type Pending = {
  requestId: string;
  editor: string;
  command: PlanCommand;
  generation: number;
  status: string;
  rejection: { status: number; message: string } | null;
};
export type EditorRow = { editor: string; draft: Draft };
type CacheRow = { snapshot: PlanSnapshot; cursor: number };
type OutboxRow = {
  request_id: string;
  editor: string;
  command: PlanCommand;
  generation: number;
  status: string;
  rejection: { status: number; message: string } | null;
};

export type HtmlArchive = {
  editors: { editor: string; draft: Draft }[];
  outbox: (OutboxRow & { created_at: string })[];
};

export class LocalDatabase {
  constructor(
    private db: PGlite,
    readonly plan: string,
    readonly editor: string,
  ) {}

  static async initialize(db: PGlite) {
    await db.exec(`CREATE TABLE IF NOT EXISTS plan_cache (
      plan TEXT PRIMARY KEY, snapshot JSONB NOT NULL, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_editors (
      plan TEXT NOT NULL, editor TEXT NOT NULL, draft JSONB NOT NULL, PRIMARY KEY(plan, editor));
      CREATE TABLE IF NOT EXISTS plan_outbox (
      request_id TEXT PRIMARY KEY, plan TEXT NOT NULL, editor TEXT NOT NULL,
      command JSONB NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE plan_outbox ADD COLUMN IF NOT EXISTS rejection JSONB;
      CREATE TABLE IF NOT EXISTS plan_html_archive (
      plan TEXT PRIMARY KEY, payload JSONB NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS plan_comment_readers (
      plan TEXT NOT NULL, editor TEXT NOT NULL, PRIMARY KEY(plan, editor));`);
    // Freeze the original records before snapshot acceptance can reconcile old drafts.
    // Pending requests may already have reached the server; their outcome remains uncertain.
    await db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO plan_html_archive(plan,payload)
        SELECT plan,jsonb_build_object(
          'editors',COALESCE((SELECT jsonb_agg(jsonb_build_object('editor',editor,'draft',draft))
            FROM plan_editors e WHERE e.plan=p.plan),'[]'::jsonb),
          'outbox',COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM plan_outbox o
            WHERE o.plan=p.plan AND command->>'kind'='html'),'[]'::jsonb))
        FROM (SELECT plan FROM plan_editors UNION SELECT plan FROM plan_outbox
          WHERE command->>'kind'='html') p ON CONFLICT DO NOTHING;
        DELETE FROM plan_outbox WHERE command->>'kind'='html';`);
    });
  }

  async read() {
    const cache = (
      await this.db.query<CacheRow>("SELECT snapshot,cursor FROM plan_cache WHERE plan=$1", [
        this.plan,
      ])
    ).rows[0];
    const ready = await this.db.query(
      "SELECT editor FROM plan_comment_readers WHERE plan=$1 AND editor=$2",
      [this.plan, this.editor],
    );
    return {
      snapshot: cache?.snapshot ?? null,
      cursor: cache?.cursor ?? 0,
      commentReady: ready.rows.length > 0,
    };
  }

  async initialize(snapshot: PlanSnapshot) {
    await this.accept(snapshot);
    await this.db.query(
      "INSERT INTO plan_comment_readers(plan,editor) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [this.plan, this.editor],
    );
  }

  async archive(): Promise<HtmlArchive | null> {
    return (
      (
        await this.db.query<{ payload: HtmlArchive }>(
          "SELECT payload FROM plan_html_archive WHERE plan=$1",
          [this.plan],
        )
      ).rows[0]?.payload ?? null
    );
  }

  async queueCommand(command: PlanCommand) {
    if (command.kind === "html") throw new Error("Browser readers cannot submit HTML.");
    await this.db.query(
      "INSERT INTO plan_outbox(request_id,plan,editor,command,generation) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING",
      [command.requestId, this.plan, this.editor, JSON.stringify(command)],
    );
  }

  async pending(): Promise<Pending[]> {
    const rows = (
      await this.db.query<OutboxRow>(
        "SELECT request_id,editor,command,generation,status,rejection FROM plan_outbox WHERE plan=$1 AND command->>'kind'<>'html' ORDER BY created_at,request_id",
        [this.plan],
      )
    ).rows;
    return rows.map((row) => ({
      requestId: row.request_id,
      editor: row.editor,
      command: row.command,
      generation: row.generation,
      status: row.status,
      rejection: row.rejection,
    }));
  }

  async reject(requestId: string, status: number, message: string) {
    await this.db.query(
      "UPDATE plan_outbox SET status='rejected',rejection=$3 WHERE plan=$1 AND request_id=$2 AND status='pending' AND command->>'kind'<>'html'",
      [this.plan, requestId, JSON.stringify({ status, message })],
    );
  }

  async dismissRejected(requestId: string, replacement?: PlanCommand) {
    if (replacement?.kind === "html") throw new Error("Browser readers cannot submit HTML.");
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          "SELECT request_id FROM plan_outbox WHERE plan=$1 AND request_id=$2 AND status='rejected' AND command->>'kind'<>'html'",
          [this.plan, requestId],
        )
      ).rows[0];
      if (!row) return;
      if (replacement)
        await tx.query(
          "INSERT INTO plan_outbox(request_id,plan,editor,command,generation) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING",
          [replacement.requestId, this.plan, this.editor, JSON.stringify(replacement)],
        );
      await tx.query("DELETE FROM plan_outbox WHERE plan=$1 AND request_id=$2", [
        this.plan,
        requestId,
      ]);
    });
  }

  async accept(snapshot: PlanSnapshot, requestId?: string | string[]) {
    const acknowledged = typeof requestId === "string" ? [requestId] : (requestId ?? []);
    await this.db.transaction(async (tx) => {
      const prior = (
        await tx.query<CacheRow>("SELECT snapshot,cursor FROM plan_cache WHERE plan=$1", [
          this.plan,
        ])
      ).rows[0];
      const current =
        prior && prior.snapshot.revision > snapshot.revision ? prior.snapshot : snapshot;
      if (!prior || current.revision > prior.snapshot.revision || snapshot.revision > prior.cursor)
        await tx.query(
          `INSERT INTO plan_cache(plan,snapshot,cursor) VALUES($1,$2,$3)
        ON CONFLICT(plan) DO UPDATE SET snapshot=excluded.snapshot,cursor=excluded.cursor`,
          [this.plan, JSON.stringify(current), Math.max(prior?.cursor ?? 0, snapshot.revision)],
        );
      if (acknowledged.length)
        await tx.query(
          "DELETE FROM plan_outbox WHERE plan=$1 AND request_id=ANY($2::text[]) AND command->>'kind'<>'html'",
          [this.plan, acknowledged],
        );
    });
  }
}
