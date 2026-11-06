import type { Header } from "./header.ts";
import type { Plate, PlateNode } from "./svg.ts";
import {
  arrowHead,
  Bounds,
  DETAIL_LINE,
  DETAIL_PX,
  labelSize,
  labelSvg,
  measurePlate,
  plateSvg,
  svgDocument,
  svgText,
} from "./svg.ts";
import { cleanLabel, num, splitDetail, takeTags, textWidth, wrapText } from "./text.ts";

const MAX_PARTICIPANTS = 10;
const MAX_EVENTS = 80;
const MIN_GAP = 120;
const SELF_LOOP = 28;

type SequenceEvent =
  | { type: "message"; from: number; to: number; label: string[]; dashed: boolean }
  | { type: "note"; over: number[]; text: string[] }
  | { type: "section"; text: string };
type Sequence = { participants: PlateNode[]; events: SequenceEvent[] };

/**
 * `sequence`. Lines are messages (`A -> B: msg`, reply `B --> A: msg`), notes
 * (`note A: text`, `note A, B: text`), dividers (`== Section ==`) and participant
 * lines (`Name | detail`), which fix the column order.
 */
export function renderSequence(header: Header, lines: readonly string[]): string | null {
  const sequence = parseSequence(lines);
  if (sequence.participants.length === 0) return null;
  return drawSequence(sequence, header);
}

function parseSequence(lines: readonly string[]): Sequence {
  const sequence: Sequence = { participants: [], events: [] };
  for (const raw of lines) {
    if (sequence.events.length >= MAX_EVENTS) break;
    const event = parseLine(sequence, raw.trim());
    if (event) sequence.events.push(event);
  }
  return sequence;
}

function parseLine(sequence: Sequence, line: string): SequenceEvent | null {
  const section = /^==+\s*(.*?)\s*==+$/.exec(line);
  if (section) return { type: "section", text: cleanLabel(section[1]!) };
  const note = /^note\s+(?:over\s+|left of\s+|right of\s+)?([^:]+):(.*)$/i.exec(line);
  if (note) {
    const over = note[1]!
      .split(",")
      .map((name) => participant(sequence, name))
      .filter((index) => index >= 0);
    const text = wrapText(cleanLabel(note[2]!), DETAIL_PX, 170);
    return over.length > 0 ? { type: "note", over, text } : null;
  }
  const message = /^(.+?)\s*(-->>|->>|-->|->)\s*([^:]+?)\s*(?::(.*))?$/.exec(line);
  if (message) {
    const from = participant(sequence, message[1]!);
    const to = participant(sequence, message[3]!);
    if (from < 0 || to < 0) return null;
    const label = wrapText(cleanLabel(message[4] ?? ""), DETAIL_PX, 220);
    return { type: "message", from, to, label, dashed: message[2]!.startsWith("--") };
  }
  participant(sequence, line);
  return null;
}

/** The column index for `text`, adding a participant on first use. */
function participant(sequence: Sequence, text: string): number {
  const { text: name, tags } = takeTags(text);
  const { head, detail } = splitDetail(name);
  const label = cleanLabel(head);
  if (!label) return -1;
  const index = sequence.participants.findIndex(
    (known) => known.head.toLowerCase() === label.toLowerCase(),
  );
  if (index >= 0) {
    const known = sequence.participants[index]!;
    if (detail) known.detail = detail;
    for (const tag of tags.names) known.tags.names.add(tag);
    if (tags.series !== null) known.tags.series = tags.series;
    return index;
  }
  if (sequence.participants.length >= MAX_PARTICIPANTS) return -1;
  sequence.participants.push({ head: label, detail, tags });
  return sequence.participants.length - 1;
}

function columnCentres(plates: readonly Plate[], events: readonly SequenceEvent[]): number[] {
  const gaps = plates.slice(1).map((plate, i) => {
    return Math.max(MIN_GAP, (plates[i]!.width + plate.width) / 2 + 24);
  });
  gaps.push(0);
  for (const event of events) {
    if (event.type !== "message") continue;
    const width = labelSize(event.label).width;
    if (event.from === event.to) {
      gaps[event.from] = Math.max(gaps[event.from]!, SELF_LOOP + width + 16);
      continue;
    }
    const low = Math.min(event.from, event.to);
    const high = Math.max(event.from, event.to);
    let span = 0;
    for (let i = low; i < high; i += 1) span += gaps[i]!;
    if (span < width + 28) gaps[high - 1]! += width + 28 - span;
  }
  const centres = [plates[0]!.width / 2];
  for (let i = 1; i < plates.length; i += 1) centres.push(centres[i - 1]! + gaps[i - 1]!);
  return centres;
}

function drawSequence(sequence: Sequence, header: Header): string {
  const plates = sequence.participants.map((node) => measurePlate(node, 130));
  const centres = columnCentres(plates, sequence.events);
  const headHeight = Math.max(...plates.map((plate) => plate.height));
  const bounds = new Bounds();
  const left = centres[0]! - plates[0]!.width / 2;
  const right = centres.at(-1)! + Math.max(plates.at(-1)!.width / 2, 0);
  const rows: string[] = [];
  let y = headHeight + 18;
  for (const event of sequence.events) {
    const drawn = drawEvent(event, centres, y, { left, right });
    rows.push(drawn.svg);
    bounds.add(drawn.minX, y, drawn.maxX - drawn.minX, drawn.height);
    y += drawn.height;
  }
  const bottom = y + 6;
  const lifelines = centres.map(
    (x) =>
      `<path class="mc-lifeline" d="M${num(x)} ${num(headHeight)}V${num(Math.max(bottom, headHeight + 24))}"/>`,
  );
  const heads = plates.map((plate, i) => {
    bounds.add(centres[i]! - plate.width / 2, 0, plate.width, Math.max(bottom, headHeight + 24));
    return plateSvg(plate, centres[i]!, headHeight / 2, "mc-actor");
  });
  return svgDocument(
    lifelines.join("") + rows.join("") + heads.join(""),
    bounds,
    header.title || "Sequence diagram",
  );
}

type Drawn = { svg: string; height: number; minX: number; maxX: number };

function drawEvent(
  event: SequenceEvent,
  centres: readonly number[],
  y: number,
  edges: { left: number; right: number },
): Drawn {
  if (event.type === "section") {
    const lines = event.text ? [event.text] : [];
    const middle = (edges.left + edges.right) / 2;
    const svg =
      `<path class="mc-divider" d="M${num(edges.left)} ${num(y + 14)}H${num(edges.right)}"/>` +
      labelSvg(lines, middle, y + 14);
    return { svg, height: 30, minX: edges.left, maxX: edges.right };
  }
  if (event.type === "note") return drawNote(event, centres, y);
  return drawMessage(event, centres, y);
}

function drawNote(
  event: Extract<SequenceEvent, { type: "note" }>,
  centres: readonly number[],
  y: number,
): Drawn {
  const xs = event.over.map((index) => centres[index]!);
  const textW = Math.max(...event.text.map((line) => textWidth(line, DETAIL_PX)));
  const width = Math.max(textW + 20, Math.max(...xs) - Math.min(...xs) + 40);
  const middle = (Math.max(...xs) + Math.min(...xs)) / 2;
  const height = event.text.length * DETAIL_LINE + 12;
  const x = middle - width / 2;
  const text = event.text
    .map((line, i) => svgText(line, middle, y + 6 + DETAIL_LINE * (i + 0.5), "mc-n-detail"))
    .join("");
  const svg = `<g class="mc-note"><rect class="mc-plate" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="4"/>${text}</g>`;
  return { svg, height: height + 12, minX: x, maxX: x + width };
}

function drawMessage(
  event: Extract<SequenceEvent, { type: "message" }>,
  centres: readonly number[],
  y: number,
): Drawn {
  const size = labelSize(event.label);
  const from = centres[event.from]!;
  const to = centres[event.to]!;
  const dashed = event.dashed ? " is-dashed" : "";
  if (event.from === event.to) {
    const top = y + 4;
    const bottom = top + 18;
    const path = `M${num(from)} ${num(top)}H${num(from + SELF_LOOP)}V${num(bottom)}H${num(from + 1)}`;
    const svg =
      `<g class="mc-link"><path class="mc-edge${dashed}" d="${path}"/>` +
      arrowHead({ x: from + 10, y: bottom }, { x: from + 1, y: bottom }) +
      labelSvg(event.label, from + SELF_LOOP + 8 + size.width / 2, (top + bottom) / 2) +
      "</g>";
    return { svg, height: 34, minX: from, maxX: from + SELF_LOOP + 8 + size.width };
  }
  const lineY = y + Math.max(size.height, 4) + 6;
  const tip = to > from ? to - 1 : to + 1;
  const svg =
    `<g class="mc-link"><path class="mc-edge${dashed}" d="M${num(from)} ${num(lineY)}H${num(tip)}"/>` +
    arrowHead({ x: from, y: lineY }, { x: tip, y: lineY }) +
    labelSvg(event.label, (from + to) / 2, lineY - 3 - size.height / 2) +
    "</g>";
  return { svg, height: lineY - y + 14, minX: Math.min(from, to), maxX: Math.max(from, to) };
}
