import type { Header } from "./header.ts";
import type { Plate, PlateNode, Point } from "./svg.ts";
import {
  arrowHead,
  Bounds,
  DETAIL_PX,
  HEAD_LINE,
  HEAD_PX,
  labelSize,
  labelSvg,
  measurePlate,
  orthoPath,
  plateSvg,
  svgDocument,
  svgText,
} from "./svg.ts";
import { cleanLabel, num, splitDetail, takeTags, textWidth, wrapText } from "./text.ts";

const MAX_LANES = 10;
const MAX_STEPS = 40;
const MAX_LINKS = 100;
const STEP_TEXT = 100;
const GAP = 26;
const LANE_PAD = 16;
const LANE_MIN = 58;
const FIT_WIDTH = 740;
const ARROW = /-->|->|→/;

type Step = { node: PlateNode; lane: number };
type Link = { from: number; to: number; label: string; dashed: boolean };
type Lanes = { lanes: string[]; steps: Step[]; links: Link[] };

/**
 * `swimlane [right|down]`. `## Lane` or `lane Name` lines start a lane; `- Step` and
 * `Step | detail [decision|start|end]` lines add steps to it. Steps run in written order
 * across all lanes, each linked to the next unless it has its own `A -> B: label`
 * links or is an `[end]`.
 */
export function renderSwimlane(header: Header, lines: readonly string[]): string | null {
  const model = parseLanes(lines);
  if (model.steps.length === 0) return null;
  return drawLanes(model, header);
}

function parseLanes(lines: readonly string[]): Lanes {
  const model: Lanes = { lanes: [], steps: [], links: [] };
  const byName = new Map<string, number>();
  const pending: { line: string; lane: number }[] = [];
  let lane = -1;
  const laneFor = (name: string): number => {
    const label = cleanLabel(name);
    const known = model.lanes.findIndex(
      (existing) => existing.toLowerCase() === label.toLowerCase(),
    );
    if (known >= 0) return known;
    if (model.lanes.length >= MAX_LANES) return model.lanes.length - 1;
    model.lanes.push(label);
    return model.lanes.length - 1;
  };
  const addStep = (text: string, inLane: number): number | null => {
    const { text: rest, tags } = takeTags(text);
    const { head, detail } = splitDetail(rest);
    const label = cleanLabel(head);
    if (!label) return null;
    const key = label.toLowerCase();
    if (model.steps.length >= MAX_STEPS) return byName.get(key) ?? null;
    if (inLane < 0) inLane = laneFor("");
    model.steps.push({ node: { head: label, detail, tags }, lane: inLane });
    const index = model.steps.length - 1;
    if (!byName.has(key)) byName.set(key, index);
    return index;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^(?:#{1,4}\s*|lane\s*:?\s+|pool\s*:?\s+)(.*)$/i.exec(line);
    if (heading) {
      lane = laneFor(heading[1]!);
      continue;
    }
    if (ARROW.test(line)) {
      pending.push({ line, lane });
      continue;
    }
    addStep(line.replace(/^(?:\d+[.)]|[-*•])\s+/u, ""), lane);
  }
  // Links are read after every step, so they can name steps written further down.
  const findStep = (text: string, inLane: number): number | null => {
    const { text: rest } = takeTags(text);
    const key = cleanLabel(splitDetail(rest).head).toLowerCase();
    return byName.get(key) ?? addStep(text, inLane);
  };
  const explicit = new Set<number>();
  for (const { line, lane: inLane } of pending) {
    const parts = line.replace(/→/g, "->").split(/\s*(-->|->)\s*/);
    let previous = findStep(parts[0]!.replace(/^[-*•]\s+/u, ""), inLane);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const segment = parts[i + 1]!;
      const colon = segment.indexOf(":");
      const name = colon < 0 ? segment : segment.slice(0, colon);
      const label = colon < 0 ? "" : cleanLabel(segment.slice(colon + 1));
      const next = findStep(name, inLane);
      if (previous !== null && next !== null && previous !== next) {
        if (model.links.length < MAX_LINKS) {
          model.links.push({ from: previous, to: next, label, dashed: parts[i] === "-->" });
        }
        explicit.add(previous);
      }
      previous = next;
    }
  }
  for (let index = 0; index + 1 < model.steps.length; index += 1) {
    if (explicit.has(index) || model.steps[index]!.node.tags.names.has("end")) continue;
    if (model.links.length >= MAX_LINKS) break;
    model.links.push({ from: index, to: index + 1, label: "", dashed: false });
  }
  return model;
}

/**
 * Positions along the flow (`a`) and across the lanes (`c`). Right-running lanes map
 * `a` to x; down-running lanes map it to y.
 */
type Layout = {
  down: boolean;
  plates: Plate[];
  headerSize: number;
  laneNames: string[][];
  laneStart: number[];
  laneEnd: number[];
  alongEnd: number;
  center: { a: number; c: number }[];
  half: { a: number; c: number }[];
  gapMid: number[];
  labels: string[][];
};

function layoutLanes(model: Lanes, down: boolean): Layout {
  const plates = model.steps.map((step) => measurePlate(step.node, STEP_TEXT));
  const half = plates.map((plate) =>
    down
      ? { a: plate.height / 2, c: plate.width / 2 }
      : { a: plate.width / 2, c: plate.height / 2 },
  );
  const labels = model.links.map((link) => wrapText(link.label, DETAIL_PX, 110));
  const laneNames = model.lanes.map((name) =>
    name ? wrapText(name, HEAD_PX, down ? 150 : 92) : [],
  );
  const nameW = (lines: string[]) => Math.max(0, ...lines.map((line) => textWidth(line, HEAD_PX)));
  const headerSize = down
    ? Math.max(0, ...laneNames.map((lines) => lines.length)) * HEAD_LINE + 16
    : Math.min(120, Math.max(56, ...laneNames.map((lines) => nameW(lines) + 22)));

  // Each step has its own column, so a gap between neighbours is free for a link label.
  const gaps = model.steps.map(() => GAP);
  model.links.forEach((link, index) => {
    if (link.to !== link.from + 1) return;
    const size = labelSize(labels[index]!);
    const need = (down ? size.height : size.width) + 14;
    if (size.width > 0) gaps[link.from] = Math.max(gaps[link.from]!, need);
  });
  const center: { a: number; c: number }[] = [];
  const gapMid: number[] = [];
  let cursor = headerSize + 18;
  model.steps.forEach((_step, index) => {
    center.push({ a: cursor + half[index]!.a, c: 0 });
    cursor += half[index]!.a * 2;
    gapMid.push(cursor + gaps[index]! / 2);
    cursor += gaps[index]!;
  });
  const alongEnd = cursor - gaps.at(-1)! + 18;

  const laneStart: number[] = [];
  const laneEnd: number[] = [];
  let across = 0;
  model.lanes.forEach((_lane, lane) => {
    const members = model.steps.flatMap((step, index) => (step.lane === lane ? [index] : []));
    const contents = Math.max(0, ...members.map((index) => half[index]!.c * 2)) + LANE_PAD * 2;
    const nameNeed = down ? nameW(laneNames[lane]!) + 24 : laneNames[lane]!.length * HEAD_LINE + 16;
    const size = Math.max(LANE_MIN, contents, nameNeed);
    laneStart.push(across);
    across += size;
    laneEnd.push(across);
    for (const index of members) center[index]!.c = (laneStart[lane]! + across) / 2;
  });
  return {
    down,
    plates,
    headerSize,
    laneNames,
    laneStart,
    laneEnd,
    alongEnd,
    center,
    half,
    gapMid,
    labels,
  };
}

function drawLanes(model: Lanes, header: Header): string {
  let layout = layoutLanes(model, /^(down|td|tb|vertical)$/i.test(header.arg));
  // Long processes laid out left to right shrink to unreadable text in a section.
  if (!header.arg.trim() && layout.alongEnd > FIT_WIDTH) layout = layoutLanes(model, true);
  const at = (a: number, c: number): Point => (layout.down ? { x: c, y: a } : { x: a, y: c });
  const parts: string[] = [bandsSvg(layout, at)];
  const corridors = new Map<string, number>();
  model.links.forEach((link, index) => {
    parts.push(linkSvg(model, layout, link, layout.labels[index]!, corridors, at));
  });
  model.steps.forEach((_step, index) => {
    const point = at(layout.center[index]!.a, layout.center[index]!.c);
    parts.push(plateSvg(layout.plates[index]!, point.x, point.y, "mc-lane-step"));
  });
  const bounds = new Bounds();
  const corner = at(layout.alongEnd, layout.laneEnd.at(-1) ?? 0);
  bounds.add(0, 0, corner.x, corner.y);
  return svgDocument(parts.join(""), bounds, header.title || "Swimlane diagram");
}

function bandsSvg(layout: Layout, at: (a: number, c: number) => Point): string {
  const end = layout.laneEnd.at(-1) ?? 0;
  const out: string[] = [];
  const rect = (a0: number, c0: number, a1: number, c1: number, className: string) => {
    const p = at(a0, c0);
    const q = at(a1, c1);
    return `<rect class="${className}" x="${num(Math.min(p.x, q.x))}" y="${num(Math.min(p.y, q.y))}" width="${num(Math.abs(q.x - p.x))}" height="${num(Math.abs(q.y - p.y))}"/>`;
  };
  const line = (a0: number, c0: number, a1: number, c1: number, className: string) => {
    const p = at(a0, c0);
    const q = at(a1, c1);
    return `<path class="${className}" d="M${num(p.x)} ${num(p.y)}L${num(q.x)} ${num(q.y)}"/>`;
  };
  layout.laneStart.forEach((start, lane) => {
    const stop = layout.laneEnd[lane]!;
    out.push(
      rect(0, start, layout.alongEnd, stop, lane % 2 ? "mc-lane-band is-alt" : "mc-lane-band"),
    );
    out.push(rect(0, start, layout.headerSize, stop, "mc-lane-head"));
    if (lane > 0) out.push(line(0, start, layout.alongEnd, start, "mc-lane-line"));
    const names = layout.laneNames[lane]!;
    const middle = (start + stop) / 2;
    names.forEach((text, row) => {
      const offset = (row - (names.length - 1) / 2) * HEAD_LINE;
      const point = layout.down
        ? at(layout.headerSize / 2 + offset, middle)
        : at(layout.headerSize / 2, middle + offset);
      out.push(svgText(text, point.x, point.y, "mc-lane-name"));
    });
  });
  out.push(line(layout.headerSize, 0, layout.headerSize, end, "mc-lane-line"));
  const corner = at(layout.alongEnd, end);
  out.push(
    `<rect class="mc-lane-frame" x="0" y="0" width="${num(corner.x)}" height="${num(corner.y)}" rx="4"/>`,
  );
  return `<g class="mc-lanes">${out.join("")}</g>`;
}

/**
 * A right-angled link. Neighbouring steps join through the gap between their columns.
 * Longer links leave the side of the step, run along a lane edge, where no step sits,
 * and enter the target from its side.
 */
function linkSvg(
  model: Lanes,
  layout: Layout,
  link: Link,
  label: string[],
  corridors: Map<string, number>,
  at: (a: number, c: number) => Point,
): string {
  const { center, half } = layout;
  const a = center[link.from]!;
  const b = center[link.to]!;
  const ha = half[link.from]!;
  const hb = half[link.to]!;
  const fromLane = model.steps[link.from]!.lane;
  const toLane = model.steps[link.to]!.lane;
  let points: { a: number; c: number }[];
  let labelAt: { a: number; c: number };
  const clearBetween =
    link.to > link.from &&
    model.steps.slice(link.from + 1, link.to).every((step) => step.lane !== fromLane);
  if (link.to === link.from + 1 || (fromLane === toLane && clearBetween)) {
    const start = { a: a.a + ha.a, c: a.c };
    const end = { a: b.a - hb.a, c: b.c };
    if (fromLane === toLane) {
      points = [start, end];
      labelAt = { a: (start.a + end.a) / 2, c: a.c };
    } else {
      const mid = layout.gapMid[link.from]!;
      points = [start, { a: mid, c: a.c }, { a: mid, c: b.c }, end];
      labelAt = { a: mid, c: (a.c + b.c) / 2 };
    }
  } else {
    const towardEnd = toLane > fromLane;
    const sameLane = toLane === fromLane;
    let corridor = towardEnd ? layout.laneEnd[fromLane]! : layout.laneStart[fromLane]!;
    if (sameLane) corridor += LANE_PAD / 2 - 1;
    // Links leaving either side of the same lane edge share it, so they are spread apart.
    const key = `${num(corridor)}`;
    const used = corridors.get(key) ?? 0;
    corridors.set(key, used + 1);
    corridor += (towardEnd ? -1 : 1) * Math.min(used, 3) * 6;
    const leave = towardEnd ? a.c + ha.c : a.c - ha.c;
    const enter = towardEnd ? b.c - hb.c : sameLane ? b.c - hb.c : b.c + hb.c;
    points = [
      { a: a.a, c: leave },
      { a: a.a, c: corridor },
      { a: b.a, c: corridor },
      { a: b.a, c: enter },
    ];
    labelAt = { a: corridorLabel(layout, link), c: corridor };
  }
  const mapped = points.map((point) => at(point.a, point.c));
  if (mapped.length < 2) return "";
  const path = `<path class="mc-edge${link.dashed ? " is-dashed" : ""}" d="${orthoPath(mapped, 6)}"/>`;
  const head = arrowHead(mapped.at(-2)!, mapped.at(-1)!);
  const where = at(labelAt.a, labelAt.c);
  const text = label[0] ? labelSvg(label, where.x, where.y) : "";
  return `<g class="mc-link">${path}${head}${text}</g>`;
}

/**
 * Where a lane-edge link puts its label: over a step column between its ends, or just
 * inside the source column, so it never sits where a neighbouring link crosses the edge.
 */
function corridorLabel(layout: Layout, link: Link): number {
  const low = Math.min(link.from, link.to);
  const high = Math.max(link.from, link.to);
  if (high - low > 1) return layout.center[Math.floor((low + high) / 2)]!.a;
  const from = layout.center[link.from]!.a;
  const toward = Math.sign(layout.center[link.to]!.a - from);
  return from + (toward * layout.half[link.from]!.a) / 2;
}
