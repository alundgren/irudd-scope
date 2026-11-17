import { randomUUID } from "node:crypto";
import type { CanvasStore } from "../../../library/canvas-store.ts";
import { findCardTools } from "../cards/registry.ts";
import type { CanvasActor, CanvasTarget, CanvasWriteResult, KeptField } from "../contract.ts";
import type { CardImages } from "./card-image.ts";
import type { ChatTarget } from "./contract.ts";
import type { ToolAnswer } from "./harness.ts";

/** What an agent sends to edit_diagram. */
export type EditInput = { changes: unknown; version?: number; requestId?: string };

const AGENT_REQUEST = /^[A-Za-z0-9_-]{1,56}$/;
const POSITION = new Set(["x", "y", "w", "h"]);

const answer = (ok: boolean, value: unknown): ToolAnswer => ({
  ok,
  text: typeof value === "string" ? value : JSON.stringify(value),
});

type Announce = (
  tabId: string,
  target: CanvasTarget,
  actor: CanvasActor,
  result: CanvasWriteResult,
) => CanvasWriteResult;

/** The card tools behind every card chat: reads, agent edits, and undoing an agent's turn. */
export function cardToolService(canvases: CanvasStore, announce: Announce, images?: CardImages) {
  async function card({ tabId, cardId }: ChatTarget) {
    const snapshot = await canvases.snapshot(tabId);
    const row = snapshot?.cards[cardId];
    const tools = row && findCardTools(row.type);
    if (!row || !tools) return null;
    return { row, tools, title: snapshot.board.cards[cardId]?.title ?? "" };
  }

  return {
    /** The guides for the tools of the card's type, or null when it has none. */
    async guides(target: ChatTarget) {
      const found = await card(target);
      return found && { read: found.tools.readGuide, edit: found.tools.editGuide };
    },

    async read(target: ChatTarget): Promise<{ answer: ToolAnswer; version?: number }> {
      const found = await card(target);
      if (!found) return { answer: answer(false, "This card is gone.") };
      const { row, tools, title } = found;
      const empty = !Object.keys(row.content).length;
      // The picture helps but is never needed, so a failure only leaves a note.
      const image = empty ? null : await images?.draw(row.type, row.content).catch(() => null);
      const picture = image
        ? {
            width: image.width,
            height: image.height,
            scale: round(image.scale),
            left: round(image.left),
            top: round(image.top),
          }
        : empty
          ? "None, because the card is empty."
          : "No picture was available this time.";
      return {
        answer: {
          ...answer(true, {
            title,
            version: row.version,
            picture,
            ...(tools.describe(row.content) as object),
          }),
          ...(image ? { png: image.png } : {}),
        },
        version: row.version,
      };
    },

    /**
     * Applies an agent's changes at once, as part of its turn. `lastRead` is the version this
     * chat last read; a change says which version it was made from, or is checked against that.
     */
    async edit(
      target: ChatTarget,
      turnId: string,
      input: EditInput,
      lastRead: number | undefined,
    ): Promise<{ answer: ToolAnswer; changes: string[] }> {
      const canvasTarget = { card: target.cardId };
      if (input.requestId !== undefined && !AGENT_REQUEST.test(input.requestId))
        return {
          answer: answer(false, "requestId must be 1 to 56 letters, digits, - or _."),
          changes: [],
        };
      const request = { changes: input.changes, version: input.version ?? null };
      const requestId = `agent-${input.requestId ?? randomUUID().replaceAll("-", "")}`;
      if (input.requestId !== undefined) {
        const saved = await canvases.answered(target.tabId, canvasTarget, requestId, request);
        if (saved) return { answer: result(saved), changes: [] };
      }
      const found = await card(target);
      if (!found) return { answer: answer(false, "This card is gone."), changes: [] };
      const planned = found.tools.plan(found.row.content, input.changes);
      if ("error" in planned) return { answer: answer(false, planned.error), changes: [] };
      if (!planned.ops.length) return { answer: answer(false, "Nothing to change."), changes: [] };
      const written = announce(
        target.tabId,
        canvasTarget,
        "agent",
        await canvases.change(
          {
            tabId: target.tabId,
            requestId,
            target: canvasTarget,
            base: input.version ?? lastRead ?? found.row.version,
            label: planned.summary.join(", ").slice(0, 160) || "Agent change",
            ops: planned.ops,
          },
          "agent",
          { turnId, request, warnings: planned.warnings },
        ),
      );
      return {
        answer: result(written),
        changes: written.ok ? planned.summary : [],
      };
    },

    /** Undoes an agent turn on its card and says what it kept because someone changed it since. */
    async undoTurn(target: ChatTarget, turnId: string): Promise<string[]> {
      const written = announce(
        target.tabId,
        { card: target.cardId },
        "person",
        await canvases.undoTurn(target.tabId, target.cardId, turnId, `undo-${turnId}`),
      );
      if (!written.ok) throw new Error(written.message);
      const found = await card(target);
      return keptNotices(written.kept, found?.row.content ?? {});
    },
  };
}

export type CardToolService = ReturnType<typeof cardToolService>;

const round = (value: number) => Math.round(value * 1000) / 1000;

function result(written: CanvasWriteResult): ToolAnswer {
  if (!written.ok) return answer(false, `Refused (${written.code}): ${written.message}`);
  // Records added without a ref get names starting with an underscore, which agents never see.
  const refs = Object.fromEntries(
    Object.entries(written.refs)
      .map(([name, id]) => [name.slice(1), id])
      .filter(([name]) => !name.startsWith("_")),
  );
  return answer(true, {
    version: written.version,
    ...(Object.keys(refs).length ? { refs } : {}),
    ...(written.warnings ? { warnings: written.warnings } : {}),
  });
}

function keptNotices(kept: readonly KeptField[], content: Record<string, Record<string, unknown>>) {
  const notices = new Set<string>();
  for (const { id, field } of kept) {
    const record = content[id];
    const name =
      (typeof record?.text === "string" && record.text.trim().split("\n")[0].slice(0, 40)) ||
      (typeof record?.label === "string" && record.label) ||
      "a record";
    if (field && POSITION.has(field)) notices.add(`Kept ${name} where you moved it.`);
    else if (field === "text" || field === "label") notices.add(`Kept your text in ${name}.`);
    else notices.add(`Kept your change to ${name}.`);
  }
  return [...notices];
}
