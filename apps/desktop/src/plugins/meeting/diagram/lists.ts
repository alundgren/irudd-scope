import { escapeHtml } from "../html.ts";
import type { Tags } from "./text.ts";
import { cleanLabel, splitDetail, takeTags } from "./text.ts";

const MAX_ITEMS = 60;

function toneClass(tags: Tags): string {
  return tags.series === null ? "" : ` is-toned mc-s${tags.series}`;
}

function detailHtml(detail: string, className: string): string {
  return detail ? `<div class="${className}">${escapeHtml(detail)}</div>` : "";
}

/** `steps`: `Title | detail [done|now]`. Leading `1.` or `-` markers are ignored. */
export function renderSteps(lines: readonly string[]): string | null {
  const steps = lines.slice(0, MAX_ITEMS).flatMap((line) => {
    const { text, tags } = takeTags(line.trim().replace(/^(?:\d+[.)]|[-*•])\s+/u, ""));
    const { head, detail } = splitDetail(text);
    return head ? [{ head, detail, tags }] : [];
  });
  const items = steps.map(({ head, detail, tags }, index) => {
    const state = tags.names.has("done") ? " is-done" : tags.names.has("now") ? " is-now" : "";
    return (
      `<li class="mc-step${state}${toneClass(tags)}"><span class="mc-step-n" aria-hidden="true">${index + 1}</span>` +
      `<div class="mc-step-body"><div class="mc-step-head">${escapeHtml(head)}</div>${detailHtml(detail, "mc-step-detail")}</div></li>`
    );
  });
  return items.length > 0 ? `<ol class="mc-steps">${items.join("")}</ol>` : null;
}

/** `timeline`: `When: what | detail [now]`. */
export function renderTimeline(lines: readonly string[]): string | null {
  const items = lines.slice(0, MAX_ITEMS).flatMap((line) => {
    const { text, tags } = takeTags(line.trim().replace(/^[-*•]\s+/, ""));
    const colon = text.indexOf(":");
    const when = colon < 0 ? "" : cleanLabel(text.slice(0, colon));
    const { head, detail } = splitDetail(colon < 0 ? text : text.slice(colon + 1));
    if (!head && !when) return [];
    const state = tags.names.has("now") ? " is-now" : tags.names.has("done") ? " is-done" : "";
    return [
      `<li class="mc-event${state}${toneClass(tags)}"><div class="mc-when">${escapeHtml(when)}</div>` +
        `<div class="mc-what">${escapeHtml(head)}</div>${detailHtml(detail, "mc-event-detail")}</li>`,
    ];
  });
  return items.length > 0 ? `<ol class="mc-timeline">${items.join("")}</ol>` : null;
}

/** `checklist`: `[x] item | owner` and `[ ] item`. Other lines are open items. */
export function renderChecklist(lines: readonly string[]): string | null {
  const items = lines.slice(0, MAX_ITEMS).flatMap((line) => {
    const match = /^\s*(?:[-*•]\s+)?(?:\[([ xX✓✔]?)\]\s*)?(.*)$/u.exec(line)!;
    const done = Boolean(match[1]?.trim());
    const { text } = takeTags(match[2]!);
    const { head, detail } = splitDetail(text);
    if (!head) return [];
    const owner = detail ? `<span class="mc-owner">${escapeHtml(detail)}</span>` : "";
    return [
      `<li class="mc-check-item${done ? " is-done" : ""}"><span class="mc-check" role="img" aria-label="${done ? "Done" : "Open"}"></span>` +
        `<span class="mc-check-text">${escapeHtml(head)}</span>${owner}</li>`,
    ];
  });
  return items.length > 0 ? `<ul class="mc-checklist">${items.join("")}</ul>` : null;
}

type Option = { name: string; tags: Tags; pros: string[]; cons: string[]; notes: string[] };

/** `compare`: `## Option [key]` headings with `+ pro`, `- con` and `= note` lines. */
export function renderCompare(lines: readonly string[]): string | null {
  const options: Option[] = [];
  const lead: string[] = [];
  for (const raw of lines.slice(0, MAX_ITEMS * 2)) {
    const line = raw.trim();
    const heading = /^#{1,4}\s*(.+)$/.exec(line);
    if (heading) {
      const { text, tags } = takeTags(heading[1]!);
      if (options.length < 6) options.push({ name: text, tags, pros: [], cons: [], notes: [] });
      continue;
    }
    const current = options.at(-1);
    const item = cleanLabel(line.replace(/^[-+=−•*]\s*/u, ""));
    if (!item) continue;
    if (!current) lead.push(item);
    else if (line.startsWith("+")) current.pros.push(item);
    else if (/^[-−]/u.test(line)) current.cons.push(item);
    else current.notes.push(item);
  }
  if (options.length === 0) return null;
  const list = (items: string[], className: string) =>
    items.length === 0
      ? ""
      : `<ul class="${className}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const cards = options.map(
    (option) =>
      `<article class="mc-option${option.tags.names.has("key") ? " is-key" : ""}${toneClass(option.tags)}">` +
      `<h3 class="mc-option-name">${escapeHtml(option.name)}</h3>` +
      list(option.pros, "mc-pros") +
      list(option.cons, "mc-cons") +
      option.notes.map((note) => `<p class="mc-option-note">${escapeHtml(note)}</p>`).join("") +
      "</article>",
  );
  const intro = lead.map((text) => `<p class="mc-lead">${escapeHtml(text)}</p>`).join("");
  return `${intro}<div class="mc-compare mc-cols-${Math.min(options.length, 4)}">${cards.join("")}</div>`;
}

/** `metrics`: `Label: value | note [s1]`. A note starting with `+` or `-` shows a delta. */
export function renderMetrics(lines: readonly string[]): string | null {
  const cards = lines.slice(0, 24).flatMap((line) => {
    const { text, tags } = takeTags(line.trim().replace(/^[-*•]\s+/, ""));
    const colon = text.indexOf(":");
    const label = colon < 0 ? "" : cleanLabel(text.slice(0, colon));
    const { head: value, detail: note } = splitDetail(colon < 0 ? text : text.slice(colon + 1));
    if (!value) return [];
    return [
      `<div class="mc-metric${toneClass(tags)}">${label ? `<div class="mc-eyebrow">${escapeHtml(label)}</div>` : ""}` +
        `<div class="mc-value">${escapeHtml(value)}</div>${noteHtml(note)}</div>`,
    ];
  });
  return cards.length > 0 ? `<div class="mc-metrics">${cards.join("")}</div>` : null;
}

function noteHtml(note: string): string {
  if (!note) return "";
  const delta = /^([+\-−]\S*)\s*(.*)$/u.exec(note);
  if (!delta) return `<div class="mc-metric-note">${escapeHtml(note)}</div>`;
  const direction = delta[1]!.startsWith("+") ? "is-up" : "is-down";
  const rest = delta[2] ? ` ${escapeHtml(delta[2])}` : "";
  return `<div class="mc-metric-note"><span class="mc-delta ${direction}">${escapeHtml(delta[1]!)}</span>${rest}</div>`;
}
