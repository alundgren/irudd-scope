import { escapeHtml } from "../html.ts";
import type { Header } from "./header.ts";
import { cleanLabel, num, splitDetail, takeTags } from "./text.ts";

const MAX_BARS = 40;
const NUMBER = /^[-+−]?\d(?:[\d\u00a0\u202f ,.]*\d)?/u;
const PREFIX_UNITS = new Set(["$", "€", "£", "¥"]);

/**
 * Reads `1,234`, `12 000`, `2,4` and `1.5`: spaces group thousands, and a comma is a
 * decimal point unless exactly three digits follow it.
 */
function readNumber(text: string): number {
  let value = text.replace(/[\u00a0\u202f ]/gu, "").replace("−", "-");
  if (value.includes(",") && value.includes(".")) value = value.replace(/,/g, "");
  else if (/,\d{3}$/u.test(value) && !/,\d*,\d{1,2}$/u.test(value)) value = value.replace(/,/g, "");
  else value = value.replace(",", ".");
  return Number(value);
}

type Bar = { label: string; value: number; shown: string; note: string; series: number | null };

/**
 * `bars [unit]`. `Label: number | note [s1..s7]` lines become horizontal bars in
 * written order. Bars start at zero, so negative values extend left of the axis.
 */
export function renderBars(header: Header, lines: readonly string[]): string | null {
  const unit = cleanLabel(header.arg);
  const bars = lines.slice(0, MAX_BARS).flatMap((line): Bar[] => {
    const { text, tags } = takeTags(line.trim().replace(/^[-*•]\s+/u, ""));
    const colon = text.lastIndexOf(":", text.includes("|") ? text.indexOf("|") : text.length);
    if (colon <= 0) return [];
    const label = cleanLabel(text.slice(0, colon));
    const { head, detail } = splitDetail(text.slice(colon + 1));
    const raw = head.replace(/^[$€£¥]\s*/u, "");
    const match = NUMBER.exec(raw)?.[0] ?? "";
    const rest = raw.slice(match.length).trim();
    const value = readNumber(match) * scale(rest);
    if (!label || !/\d/.test(match) || !Number.isFinite(value)) return [];
    // A value written with its own unit, such as `42%`, `$90` or `1.2k`, is shown as written.
    const shown = rest || raw !== head ? cleanLabel(head) : withUnit(match, unit);
    return [{ label, value, shown, note: detail, series: tags.series }];
  });
  if (bars.length === 0) return null;
  const low = Math.min(0, ...bars.map((bar) => bar.value));
  const high = Math.max(0, ...bars.map((bar) => bar.value));
  const span = high - low || 1;
  const rows = bars.map((bar) => {
    const start = ((Math.min(0, bar.value) - low) / span) * 100;
    const width = (Math.abs(bar.value) / span) * 100;
    const tone = bar.series === null ? "" : ` mc-s${bar.series}`;
    const note = bar.note ? `<span class="mc-bar-note">${escapeHtml(bar.note)}</span>` : "";
    return (
      `<li class="mc-bar${tone}${bar.value < 0 ? " is-negative" : ""}">` +
      `<span class="mc-bar-label">${escapeHtml(bar.label)}${note}</span>` +
      `<span class="mc-bar-track"><span class="mc-bar-fill" style="--mc-bar-start:${num(start)}%;--mc-bar-width:${num(width)}%"></span></span>` +
      `<span class="mc-bar-value">${escapeHtml(bar.shown)}</span></li>`
    );
  });
  return `<ul class="mc-bars">${rows.join("")}</ul>`;
}

/** The multiplier for a `k`, `M` or `B` suffix, so `1.2k` and `900` compare correctly. */
function scale(rest: string): number {
  if (/^k\b/i.test(rest)) return 1e3;
  if (/^M\b/.test(rest)) return 1e6;
  if (/^(?:B|bn)\b/.test(rest)) return 1e9;
  return 1;
}

/** `12%`, `$1,200` and `40 ms`: percent and currency attach, other units follow a space. */
function withUnit(value: string, unit: string): string {
  if (!unit) return value;
  if (unit === "%") return `${value}%`;
  if (PREFIX_UNITS.has(unit)) {
    const sign = /^[-−]/u.test(value) ? "−" : "";
    return `${sign}${unit}${value.replace(/^[-+−]/u, "")}`;
  }
  return `${value} ${unit}`;
}
