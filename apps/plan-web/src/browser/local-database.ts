import type { PGlite } from "@electric-sql/pglite";
import type { Actor, HtmlCommand, PlanCommand, PlanSnapshot } from "../contracts.ts";
import { mergeHtml } from "./merge.ts";

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
      CREATE TABLE IF NOT EXISTS plan_queue_attempts (request_id TEXT PRIMARY KEY);`);
  }

  async read() {
    const cache = (
      await this.db.query<CacheRow>("SELECT snapshot, cursor FROM plan_cache WHERE plan=$1", [
        this.plan,
      ])
    ).rows[0];
    const editor = (
      await this.db.query<EditorRow>("SELECT draft FROM plan_editors WHERE plan=$1 AND editor=$2", [
        this.plan,
        this.editor,
      ])
    ).rows[0];
    return {
      snapshot: cache?.snapshot ?? null,
      cursor: cache?.cursor ?? 0,
      draft: editor?.draft ?? null,
    };
  }

  async initialize(snapshot: PlanSnapshot) {
    await this.accept(snapshot);
    await this.db.transaction(async (tx) => {
      const current = (
        await tx.query<CacheRow>("SELECT snapshot FROM plan_cache WHERE plan=$1", [this.plan])
      ).rows[0].snapshot;
      const draft: Draft = {
        html: current.html,
        generation: 0,
        baseHtml: current.html,
        baseHtmlRevision: current.htmlRevision,
        dirty: false,
        conflict: null,
      };
      await tx.query(
        `INSERT INTO plan_editors(plan,editor,draft) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`,
        [this.plan, this.editor, JSON.stringify(draft)],
      );
    });
  }

  async saveDraft(draft: Draft, previousHtml?: string) {
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query<EditorRow>("SELECT draft FROM plan_editors WHERE plan=$1 AND editor=$2", [
          this.plan,
          this.editor,
        ])
      ).rows[0];
      if (row && row.draft.generation >= draft.generation) return;
      if (row && previousHtml !== undefined && row.draft.generation < draft.generation) {
        const merged = mergeHtml(previousHtml, draft.html, row.draft.html);
        draft = {
          ...row.draft,
          html: merged ?? draft.html,
          generation: draft.generation,
          dirty: true,
          actor: draft.actor ?? row.draft.actor,
        };
        if (merged === null) {
          const cache = (
            await tx.query<CacheRow>("SELECT snapshot FROM plan_cache WHERE plan=$1", [this.plan])
          ).rows[0];
          draft.conflict = cache?.snapshot ?? row.draft.conflict;
        }
      }
      await tx.query(
        `INSERT INTO plan_editors(plan,editor,draft) VALUES($1,$2,$3)
        ON CONFLICT(plan,editor) DO UPDATE SET draft=excluded.draft`,
        [this.plan, this.editor, JSON.stringify(draft)],
      );
    });
  }

  async queueHtml(actor: Actor, requestId: string) {
    await this.db.transaction(async (tx) => {
      const rows = (
        await tx.query<EditorRow>("SELECT editor,draft FROM plan_editors WHERE plan=$1", [
          this.plan,
        ])
      ).rows;
      const pending = (
        await tx.query<{ editor: string }>(
          "SELECT editor FROM plan_outbox WHERE plan=$1 AND command->>'kind'='html' AND status IN ('pending','conflict')",
          [this.plan],
        )
      ).rows;
      const eligible = rows.filter(
        (row) =>
          row.draft.dirty &&
          !row.draft.conflict &&
          row.draft.generation > (row.draft.rejectedGeneration ?? -1) &&
          !pending.some((item) => item.editor === row.editor),
      );
      if (!eligible.length) return;
      // A lost RPC reply must not rebuild an already acknowledged command with a new payload.
      const attempt = await tx.query(
        "INSERT INTO plan_queue_attempts(request_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING request_id",
        [requestId],
      );
      if (!attempt.rows.length) return;
      for (const row of eligible) {
        const identity = `${requestId}:${row.editor}:${row.draft.generation}`;
        const owner =
          row.draft.actor ??
          (row.editor === this.editor
            ? actor
            : {
                id: row.editor,
                name: `Recovered editor ${row.editor.slice(0, 4)}`,
                kind: "human" as const,
              });
        const command: HtmlCommand = {
          kind: "html",
          requestId: identity,
          actor: owner,
          html: row.draft.html,
          baseHtmlRevision: row.draft.baseHtmlRevision,
        };
        await tx.query(
          "INSERT INTO plan_outbox(request_id,plan,editor,command,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [identity, this.plan, row.editor, JSON.stringify(command), row.draft.generation],
        );
      }
    });
  }

  async drafts() {
    const rows = (
      await this.db.query<EditorRow>("SELECT editor,draft FROM plan_editors WHERE plan=$1", [
        this.plan,
      ])
    ).rows;
    return rows.filter((row) => row.draft.dirty || row.draft.conflict);
  }

  async recover(editor: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const rows = (
        await tx.query<EditorRow>(
          "SELECT editor,draft FROM plan_editors WHERE plan=$1 AND editor=ANY($2::text[])",
          [this.plan, [editor, this.editor]],
        )
      ).rows;
      const original = rows.find((row) => row.editor === editor)?.draft;
      const own = rows.find((row) => row.editor === this.editor)?.draft;
      const current = (
        await tx.query<CacheRow>("SELECT snapshot FROM plan_cache WHERE plan=$1", [this.plan])
      ).rows[0]?.snapshot;
      if (!original || !current) return;
      const html = mergeHtml(original.baseHtml, original.html, current.html);
      const draft: Draft = {
        html: html ?? original.html,
        generation: (own?.generation ?? 0) + 1,
        baseHtml: current.html,
        baseHtmlRevision: current.htmlRevision,
        dirty: html !== current.html,
        conflict: html === null ? current : null,
        actor,
        rejectedGeneration:
          original.rejectedGeneration === original.generation
            ? (own?.generation ?? 0) + 1
            : undefined,
      };
      await tx.query("UPDATE plan_editors SET draft=$3 WHERE plan=$1 AND editor=$2", [
        this.plan,
        this.editor,
        JSON.stringify(draft),
      ]);
      await tx.query("DELETE FROM plan_outbox WHERE plan=$1 AND editor=$2 AND status='conflict'", [
        this.plan,
        this.editor,
      ]);
    });
  }

  async queueCommand(command: PlanCommand) {
    await this.db.query(
      "INSERT INTO plan_outbox(request_id,plan,editor,command,generation) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING",
      [command.requestId, this.plan, this.editor, JSON.stringify(command)],
    );
  }

  async pending(): Promise<Pending[]> {
    const rows = (
      await this.db.query<OutboxRow>(
        "SELECT request_id,editor,command,generation,status,rejection FROM plan_outbox WHERE plan=$1 ORDER BY created_at,request_id",
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
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query<OutboxRow>("SELECT * FROM plan_outbox WHERE plan=$1 AND request_id=$2", [
          this.plan,
          requestId,
        ])
      ).rows[0];
      if (!row || row.status !== "pending") return;
      await tx.query(
        "UPDATE plan_outbox SET status='rejected',rejection=$3 WHERE plan=$1 AND request_id=$2",
        [this.plan, requestId, JSON.stringify({ status, message })],
      );
      if (row.command.kind === "html")
        await tx.query(
          "UPDATE plan_editors SET draft=jsonb_set(draft,'{rejectedGeneration}',$3::jsonb) WHERE plan=$1 AND editor=$2",
          [this.plan, row.editor, JSON.stringify(row.generation)],
        );
    });
  }

  async dismissRejected(requestId: string, replacement?: PlanCommand) {
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query<OutboxRow>(
          "SELECT * FROM plan_outbox WHERE plan=$1 AND request_id=$2 AND status='rejected'",
          [this.plan, requestId],
        )
      ).rows[0];
      // A lost reply must not resurrect a replacement already accepted by the server.
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

  async restoreRejected(requestId: string, actor: Actor, operationId: string) {
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query<OutboxRow>(
          "SELECT * FROM plan_outbox WHERE plan=$1 AND request_id=$2 AND status='rejected'",
          [this.plan, requestId],
        )
      ).rows[0];
      if (!row || row.command.kind !== "html") return;
      const current = (
        await tx.query<CacheRow>("SELECT snapshot FROM plan_cache WHERE plan=$1", [this.plan])
      ).rows[0]?.snapshot;
      const own = (
        await tx.query<EditorRow>("SELECT draft FROM plan_editors WHERE plan=$1 AND editor=$2", [
          this.plan,
          this.editor,
        ])
      ).rows[0];
      if (!current || !own) return;
      const attempt = await tx.query(
        "INSERT INTO plan_queue_attempts(request_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING request_id",
        [operationId],
      );
      if (!attempt.rows.length) return;
      const generation = own.draft.generation + 1;
      const draft: Draft = {
        html: row.command.html,
        generation,
        baseHtml: current.html,
        baseHtmlRevision: current.htmlRevision,
        dirty: true,
        conflict: null,
        actor,
        rejectedGeneration: generation,
      };
      await tx.query("UPDATE plan_editors SET draft=$3 WHERE plan=$1 AND editor=$2", [
        this.plan,
        this.editor,
        JSON.stringify(draft),
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
      const outgoingRows = (
        await tx.query<OutboxRow>(
          "SELECT * FROM plan_outbox WHERE request_id=ANY($1::text[]) AND plan=$2",
          [acknowledged, this.plan],
        )
      ).rows;
      const rows = (
        await tx.query<EditorRow>("SELECT editor,draft FROM plan_editors WHERE plan=$1", [
          this.plan,
        ])
      ).rows;
      const needsReconciliation = rows.some(
        (row) =>
          row.draft.baseHtmlRevision < current.htmlRevision ||
          (row.draft.conflict !== null && row.draft.conflict.revision < current.revision),
      );
      if (
        prior &&
        prior.snapshot.revision >= snapshot.revision &&
        !outgoingRows.length &&
        !needsReconciliation
      )
        return;
      await tx.query(
        `INSERT INTO plan_cache(plan,snapshot,cursor) VALUES($1,$2,$3)
        ON CONFLICT(plan) DO UPDATE SET snapshot=excluded.snapshot,cursor=excluded.cursor`,
        [this.plan, JSON.stringify(current), Math.max(prior?.cursor ?? 0, snapshot.revision)],
      );
      for (const row of rows) {
        const draft = row.draft;
        const outgoing = outgoingRows.find(
          (item) => item.editor === row.editor && item.command.kind === "html",
        );
        const ownAck = Boolean(outgoing);
        const hasPending =
          (
            await tx.query(
              "SELECT request_id FROM plan_outbox WHERE plan=$1 AND editor=$2 AND command->>'kind'='html' AND status='pending' AND NOT(request_id=ANY($3::text[]))",
              [this.plan, row.editor, acknowledged],
            )
          ).rows.length > 0;
        if (hasPending && !ownAck && !draft.conflict) continue;
        if (!ownAck && !draft.conflict && current.htmlRevision === draft.baseHtmlRevision) continue;
        if (draft.conflict && !ownAck) {
          draft.conflict = current;
        } else {
          const base = ownAck ? (outgoing!.command as HtmlCommand).html : draft.baseHtml;
          const local = ownAck && draft.generation === outgoing!.generation ? base : draft.html;
          const merged = mergeHtml(base, local, current.html);
          if (merged === null) draft.conflict = current;
          else {
            draft.html = merged;
            draft.baseHtml = current.html;
            draft.baseHtmlRevision = current.htmlRevision;
            draft.dirty = merged !== current.html;
            draft.conflict = null;
          }
        }
        await tx.query("UPDATE plan_editors SET draft=$3 WHERE plan=$1 AND editor=$2", [
          this.plan,
          row.editor,
          JSON.stringify(draft),
        ]);
      }
      if (outgoingRows.length)
        await tx.query("DELETE FROM plan_outbox WHERE plan=$1 AND request_id=ANY($2::text[])", [
          this.plan,
          acknowledged,
        ]);
    });
  }

  async conflict(requestId: string, snapshot: PlanSnapshot) {
    await this.db.transaction(async (tx) => {
      const outgoing = (
        await tx.query<OutboxRow>("SELECT * FROM plan_outbox WHERE request_id=$1", [requestId])
      ).rows[0];
      if (!outgoing) return;
      const cache = (
        await tx.query<CacheRow>("SELECT snapshot FROM plan_cache WHERE plan=$1", [this.plan])
      ).rows[0];
      const current =
        cache && cache.snapshot.revision > snapshot.revision ? cache.snapshot : snapshot;
      await tx.query("UPDATE plan_outbox SET status='conflict' WHERE request_id=$1", [requestId]);
      await tx.query(
        "UPDATE plan_editors SET draft=jsonb_set(draft,'{conflict}',$3::jsonb) WHERE plan=$1 AND editor=$2",
        [this.plan, outgoing.editor, JSON.stringify(current)],
      );
    });
    await this.accept(snapshot);
  }

  async resolve(draft: Draft) {
    await this.db.transaction(async (tx) => {
      const current = (
        await tx.query<CacheRow>("SELECT snapshot FROM plan_cache WHERE plan=$1", [this.plan])
      ).rows[0]?.snapshot;
      if (current) {
        const merged = mergeHtml(draft.baseHtml, draft.html, current.html);
        draft = {
          ...draft,
          html: merged ?? draft.html,
          baseHtml: current.html,
          baseHtmlRevision: current.htmlRevision,
          dirty: merged !== current.html,
          conflict: merged === null ? current : null,
        };
      }

      await tx.query("DELETE FROM plan_outbox WHERE plan=$1 AND editor=$2 AND status='conflict'", [
        this.plan,
        this.editor,
      ]);
      await tx.query("UPDATE plan_editors SET draft=$3 WHERE plan=$1 AND editor=$2", [
        this.plan,
        this.editor,
        JSON.stringify(draft),
      ]);
    });
  }
}
