import { escapeHtml } from "../html.ts";
import type { Tags } from "./text.ts";
import { cleanLabel, splitDetail, takeTags } from "./text.ts";

const MAX_COLUMNS = 8;
const MAX_CARDS = 40;

type Card = { text: string; owner: string; tags: Tags };
type Column = { name: string; tags: Tags; cards: Card[] };

/**
 * `board`. `## Column [s1]` headings, then `- card | owner [done|key|s1..s7]` lines.
 * Cards written before the first heading go in an untitled column.
 */
export function renderBoard(lines: readonly string[]): string | null {
  const columns: Column[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^#{1,4}\s*(.*)$/.exec(line);
    if (heading) {
      const { text, tags } = takeTags(heading[1]!);
      if (columns.length < MAX_COLUMNS) columns.push({ name: cleanLabel(text), tags, cards: [] });
      continue;
    }
    const marker = /^(?:[-*•+]\s*)?(?:\[([ xX✓]?)\]\s*)?/u.exec(line)!;
    const { text, tags } = takeTags(line.slice(marker[0].length));
    const { head, detail } = splitDetail(text);
    const card = cleanLabel(head);
    if (!card) continue;
    if (columns.length === 0) columns.push({ name: "", tags: noTags(), cards: [] });
    const column = columns.at(-1)!;
    // A `[x]` checkbox marker reads as done.
    if (marker[1]?.trim()) tags.names.add("done");
    if (column.cards.length < MAX_CARDS) column.cards.push({ text: card, owner: detail, tags });
  }
  if (columns.length === 0) return null;
  return `<div class="mc-board">${columns.map(columnHtml).join("")}</div>`;
}

function noTags(): Tags {
  return { names: new Set(), series: null };
}

function toneClass(tags: Tags): string {
  return tags.series === null ? "" : ` is-toned mc-s${tags.series}`;
}

function columnHtml(column: Column): string {
  const head = column.name
    ? `<header class="mc-board-head"><h3 class="mc-board-name">${escapeHtml(column.name)}</h3><span class="mc-board-count">${column.cards.length}</span></header>`
    : "";
  const cards =
    column.cards.length === 0
      ? `<li class="mc-board-empty">No cards</li>`
      : column.cards.map(cardHtml).join("");
  return `<section class="mc-board-col${toneClass(column.tags)}">${head}<ul class="mc-board-cards">${cards}</ul></section>`;
}

function cardHtml(card: Card): string {
  const state = [
    card.tags.names.has("done") ? " is-done" : "",
    card.tags.names.has("key") ? " is-key" : "",
    toneClass(card.tags),
  ].join("");
  const owner = card.owner ? `<span class="mc-owner">${escapeHtml(card.owner)}</span>` : "";
  return `<li class="mc-board-card${state}"><span class="mc-board-text">${escapeHtml(card.text)}</span>${owner}</li>`;
}
