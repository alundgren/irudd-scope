import type { Graph } from "@dagrejs/dagre";
import dagre from "@dagrejs/dagre";
import type { Header } from "./header.ts";
import type { Plate, PlateNode, Point } from "./svg.ts";
import {
  arrowHead,
  Bounds,
  DETAIL_PX,
  labelSize,
  labelSvg,
  measurePlate,
  plateSvg,
  smoothPath,
  svgDocument,
} from "./svg.ts";
import { cleanLabel, num, splitDetail, takeTags, wrapText } from "./text.ts";

const MAX_STATES = 60;
const MAX_TRANSITIONS = 150;
const MAX_NOTES = 20;
const START = "[*]start";
const END = "[*]end";
const START_R = 7;
const END_R = 9;
const ARROW = /-->|->/;
const LOOP = 20;

type Transition = { from: string; to: string; label: string };
type Note = { state: string; text: string };
type Machine = { states: Map<string, PlateNode>; transitions: Transition[]; notes: Note[] };

/**
 * `state [right|down]`. Lines are transitions (`A -> B: event [guard]`, `[*] -> A`
 * for the start, `A -> [*]` for the end), notes (`note A: text`) and state lines
 * (`A` or `A | detail`).
 */
export function renderState(header: Header, lines: readonly string[]): string | null {
  const machine = parseMachine(lines);
  if (machine.states.size === 0) return null;
  return drawMachine(machine, header);
}

function parseMachine(lines: readonly string[]): Machine {
  const machine: Machine = { states: new Map(), transitions: [], notes: [] };
  for (const raw of lines) {
    const line = raw.trim();
    const note = /^note\s+([^:]+):\s*(.*)$/i.exec(line);
    if (note) {
      addNote(machine, note[1]!, note[2]!);
    } else if (ARROW.test(line)) {
      parseTransitions(machine, line);
    } else {
      const colon = line.indexOf(":");
      // `Idle: waiting` reads as a detail, like `Idle | waiting`.
      const text = colon > 0 && !line.includes("|") ? line.replace(":", " |") : line;
      stateKey(machine, text, "end");
    }
  }
  return machine;
}

function addNote(machine: Machine, name: string, note: string): void {
  const key = stateKey(machine, name, "end");
  const text = cleanLabel(note);
  if (key === null || key === START || key === END || !text) return;
  if (machine.notes.length < MAX_NOTES) machine.notes.push({ state: key, text });
}

function parseTransitions(machine: Machine, line: string): void {
  const parts = line.split(/\s*(?:-->|->)\s*/);
  let previous = stateKey(machine, parts[0]!, "start");
  for (let i = 1; i < parts.length; i += 1) {
    const segment = parts[i]!;
    const colon = segment.indexOf(":");
    const name = colon < 0 ? segment : segment.slice(0, colon);
    const label = colon < 0 ? "" : cleanLabel(segment.slice(colon + 1));
    const next = stateKey(machine, name, "end");
    if (previous && next && machine.transitions.length < MAX_TRANSITIONS) {
      // A transition into the start dot or out of the end dot has no meaning.
      if (next !== START && previous !== END) {
        machine.transitions.push({ from: previous, to: next, label });
      }
    }
    previous = next;
  }
}

/** Adds or updates a state from `Name | detail [tags]` and returns its key. */
function stateKey(machine: Machine, text: string, pseudo: "start" | "end"): string | null {
  if (text.trim() === "[*]") return pseudo === "start" ? START : END;
  const { text: rest, tags } = takeTags(text);
  const { head, detail } = splitDetail(rest);
  const label = cleanLabel(head);
  if (!label) return null;
  const key = label.toLowerCase();
  const existing = machine.states.get(key);
  if (existing) {
    if (detail) existing.detail = detail;
    for (const name of tags.names) existing.tags.names.add(name);
    if (tags.series !== null) existing.tags.series = tags.series;
    return key;
  }
  if (machine.states.size >= MAX_STATES) return null;
  machine.states.set(key, { head: label, detail, tags });
  return key;
}

type Layout = {
  graph: Graph;
  plates: Map<string, Plate>;
  notePlates: Plate[];
  labels: string[][];
  loopLabels: Map<string, string[]>;
  down: boolean;
};

function drawMachine(machine: Machine, header: Header): string {
  const layout = layoutMachine(machine, /^(down|td|tb|vertical)$/i.test(header.arg));
  const bounds = new Bounds();
  const parts = [
    ...machine.notes.map((note, index) => noteLinkSvg(layout, note.state, index)),
    ...machine.transitions.map((edge, index) => transitionSvg(layout, edge, index, bounds)),
    ...[...layout.plates].map(([key, plate]) => stateSvg(layout, key, plate, bounds)),
    ...layout.notePlates.map((plate, index) => {
      const node = layout.graph.node(`note:${index}`);
      if (!node) return "";
      bounds.add(node.x - plate.width / 2, node.y - plate.height / 2, plate.width, plate.height);
      return plateSvg(plate, node.x, node.y, "mc-note", 4);
    }),
    pseudoSvg(layout, bounds),
  ];
  return svgDocument(parts.join(""), bounds, header.title || "State diagram");
}

function layoutMachine(machine: Machine, down: boolean): Layout {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: down ? "TB" : "LR",
    nodesep: down ? 30 : 24,
    ranksep: down ? 44 : 60,
    edgesep: 14,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const loopLabels = selfLoopLabels(machine);
  const plates = new Map<string, Plate>();
  for (const [key, node] of machine.states) {
    const plate = measurePlate(node);
    plates.set(key, plate);
    graph.setNode(key, stateBox(plate, loopLabels.get(key), down));
  }
  const used = new Set(machine.transitions.flatMap((edge) => [edge.from, edge.to]));
  if (used.has(START)) graph.setNode(START, { width: START_R * 2, height: START_R * 2 });
  if (used.has(END)) graph.setNode(END, { width: END_R * 2, height: END_R * 2 });
  const notePlates = machine.notes.map((note) =>
    measurePlate({ head: note.text, detail: "", tags: { names: new Set(), series: null } }, 140),
  );
  notePlates.forEach((plate, index) => {
    graph.setNode(`note:${index}`, { width: plate.width, height: plate.height });
    graph.setEdge(machine.notes[index]!.state, `note:${index}`, { minlen: 1 }, `n${index}`);
  });
  const labels = machine.transitions.map((edge) => wrapText(edge.label, DETAIL_PX, 120));
  machine.transitions.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    const size = labelSize(labels[index]!);
    graph.setEdge(edge.from, edge.to, { ...size, labelpos: "c" }, `e${index}`);
  });
  dagre.layout(graph);
  return { graph, plates, notePlates, labels, loopLabels, down };
}

/**
 * The dagre box for a state. One with a self-transition is padded on both sides,
 * so dagre leaves room for the loop and its label.
 */
function stateBox(plate: Plate, loop: string[] | undefined, down: boolean) {
  if (!loop) return { width: plate.width, height: plate.height };
  const size = labelSize(loop);
  if (down) return { width: plate.width + 2 * (LOOP + 6 + size.width), height: plate.height };
  return { width: plate.width, height: plate.height + 2 * (LOOP + 4 + size.height) };
}

/** The joined labels of each state's self-transitions; dagre does not lay these out. */
function selfLoopLabels(machine: Machine): Map<string, string[]> {
  const loops = new Map<string, string[]>();
  for (const edge of machine.transitions) {
    if (edge.from !== edge.to) continue;
    const known = loops.get(edge.from) ?? [];
    if (edge.label && !known.includes(edge.label)) known.push(edge.label);
    loops.set(edge.from, known);
  }
  return new Map(
    [...loops].map(([key, known]) => [
      key,
      wrapText(known.join(", "), DETAIL_PX, 120).filter(Boolean),
    ]),
  );
}

function noteLinkSvg(layout: Layout, state: string, index: number): string {
  const laid = layout.graph.edge({ v: state, w: `note:${index}`, name: `n${index}` });
  const points: Point[] = laid?.points ?? [];
  if (points.length < 2) return "";
  return `<path class="mc-edge is-dashed mc-note-link" d="${smoothPath(points)}"/>`;
}

function transitionSvg(layout: Layout, edge: Transition, index: number, bounds: Bounds): string {
  if (edge.from === edge.to) return "";
  const laid = layout.graph.edge({ v: edge.from, w: edge.to, name: `e${index}` });
  const points: Point[] = [...(laid?.points ?? [])];
  if (points.length < 2) return "";
  points[0] = clipEnd(layout, edge.from, points[0]!, points[1]!);
  points[points.length - 1] = clipEnd(layout, edge.to, points.at(-1)!, points.at(-2)!);
  for (const point of points) bounds.add(point.x, point.y);
  const label = layout.labels[index]!;
  let text = "";
  if (label[0] && laid.x !== undefined && laid.y !== undefined) {
    const size = labelSize(label);
    bounds.add(laid.x - size.width / 2, laid.y - size.height / 2, size.width, size.height);
    text = labelSvg(label, laid.x, laid.y);
  }
  const path = `<path class="mc-edge" d="${smoothPath(points)}"/>`;
  return `<g class="mc-link">${path}${arrowHead(points.at(-2)!, points.at(-1)!)}${text}</g>`;
}

/** Dagre ends edges on the padded box of a state with a loop; this moves them to the plate. */
function clipEnd(layout: Layout, key: string, end: Point, toward: Point): Point {
  const plate = layout.plates.get(key);
  const node = layout.graph.node(key);
  if (!plate || !node || !layout.loopLabels.has(key)) return end;
  return clipToRect(node, plate.width, plate.height, toward);
}

function stateSvg(layout: Layout, key: string, plate: Plate, bounds: Bounds): string {
  const node = layout.graph.node(key);
  if (!node) return "";
  bounds.add(node.x - plate.width / 2, node.y - plate.height / 2, plate.width, plate.height);
  const loop = layout.loopLabels.get(key);
  const loopHtml = loop ? loopSvg(node, plate, loop, layout.down, bounds) : "";
  return plateSvg(plate, node.x, node.y, "mc-state", 12) + loopHtml;
}

function pseudoSvg(layout: Layout, bounds: Bounds): string {
  const parts: string[] = [];
  const start = layout.graph.node(START);
  if (start) {
    bounds.add(start.x - START_R, start.y - START_R, START_R * 2, START_R * 2);
    parts.push(
      `<circle class="mc-state-start" cx="${num(start.x)}" cy="${num(start.y)}" r="${START_R}"><title>Start</title></circle>`,
    );
  }
  const end = layout.graph.node(END);
  if (end) {
    bounds.add(end.x - END_R, end.y - END_R, END_R * 2, END_R * 2);
    parts.push(
      `<g class="mc-state-end"><title>End</title><circle class="mc-state-ring" cx="${num(end.x)}" cy="${num(end.y)}" r="${END_R - 0.75}"/>` +
        `<circle class="mc-state-dot" cx="${num(end.x)}" cy="${num(end.y)}" r="${END_R - 4}"/></g>`,
    );
  }
  return parts.join("");
}

/** Where the line from the centre of a `width` by `height` box toward `toward` leaves it. */
function clipToRect(center: Point, width: number, height: number, toward: Point): Point {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const hw = width / 2;
  const hh = height / 2;
  if (Math.abs(dy) * hw > Math.abs(dx) * hh) {
    const sy = dy < 0 ? -hh : hh;
    return { x: center.x + (sy * dx) / dy, y: center.y + sy };
  }
  const sx = dx < 0 ? -hw : hw;
  return { x: center.x + sx, y: center.y + (sx * dy) / dx };
}

/** A self-transition: a loop above the plate, or right of it when the layout runs down. */
function loopSvg(
  center: Point,
  plate: Plate,
  label: string[],
  down: boolean,
  bounds: Bounds,
): string {
  const size = labelSize(label);
  let path: string;
  let head: string;
  let labelAt: Point;
  if (down) {
    const x = center.x + plate.width / 2;
    const reach = x + LOOP * 1.4;
    path = `M${num(x)} ${num(center.y - 9)}C${num(reach)} ${num(center.y - 16)} ${num(reach)} ${num(center.y + 16)} ${num(x)} ${num(center.y + 9)}`;
    head = arrowHead({ x: x + 8, y: center.y + 12 }, { x, y: center.y + 9 });
    labelAt = { x: x + LOOP + 6 + size.width / 2, y: center.y };
    bounds.add(x, center.y - 16, LOOP + 6 + size.width, 32);
  } else {
    const y = center.y - plate.height / 2;
    const reach = y - LOOP * 1.4;
    path = `M${num(center.x - 10)} ${num(y)}C${num(center.x - 16)} ${num(reach)} ${num(center.x + 16)} ${num(reach)} ${num(center.x + 10)} ${num(y)}`;
    head = arrowHead({ x: center.x + 13, y: y - 8 }, { x: center.x + 10, y });
    labelAt = { x: center.x, y: y - LOOP - 4 - size.height / 2 };
    bounds.add(
      center.x - Math.max(16, size.width / 2),
      y - LOOP - 4 - size.height,
      Math.max(32, size.width),
      LOOP + 4 + size.height,
    );
  }
  const text = size.width > 0 ? labelSvg(label, labelAt.x, labelAt.y) : "";
  return `<g class="mc-link"><path class="mc-edge" d="${path}"/>${head}${text}</g>`;
}
