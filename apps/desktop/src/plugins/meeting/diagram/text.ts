/**
 * Text helpers shared by the diagram parsers and renderers. Widths are estimated
 * from character counts because diagrams also render in Node, without a DOM.
 */

/** Average glyph advance of the system UI font, in em. */
const CHAR_EM = 0.56;
/** CJK, Hangul and other full-width characters take about one em. */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

export function textWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const char of text) em += WIDE_CHAR.test(char) ? 1 : CHAR_EM;
  return em * fontPx;
}

/** Word-wraps `text` so each line fits `maxPx`, breaking words longer than a line. */
export function wrapText(text: string, fontPx: number, maxPx: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, fontPx) <= maxPx) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const char of word) {
      if (line && textWidth(line + char, fontPx) > maxPx) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

export type Tags = { names: Set<string>; series: number | null };

const KNOWN_TAGS = /^(?:key|start|end|db|decision|muted|done|now|s[1-7])$/;

/**
 * Splits trailing `[tag]` groups off a line. `[key, s2]` and `[key] [s2]` both work.
 * A bracket group with an unknown word stays in the text, so `Budget [draft]` keeps
 * its label. Series tags `s1` to `s7` pick a data color.
 */
export function takeTags(line: string): { text: string; tags: Tags } {
  const names = new Set<string>();
  let text = line.trimEnd();
  for (;;) {
    const match = /\s*\[([^\][]*)\]$/.exec(text);
    if (!match || match.index === 0) break;
    const group = match[1]!
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (group.length === 0 || !group.every((tag) => KNOWN_TAGS.test(tag))) break;
    for (const tag of group) names.add(tag);
    text = text.slice(0, match.index).trimEnd();
  }
  let series: number | null = null;
  for (const name of names) {
    const found = /^s([1-7])$/.exec(name);
    if (found) series = Number(found[1]);
  }
  return { text, tags: { names, series } };
}

/** Splits `head | detail`. */
export function splitDetail(text: string): { head: string; detail: string } {
  const bar = text.indexOf("|");
  if (bar < 0) return { head: text.trim(), detail: "" };
  return { head: text.slice(0, bar).trim(), detail: text.slice(bar + 1).trim() };
}

/** A trimmed, single-spaced label. */
export function cleanLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Formats an SVG coordinate compactly. */
export function num(value: number): string {
  return String(Math.round(value * 10) / 10);
}
