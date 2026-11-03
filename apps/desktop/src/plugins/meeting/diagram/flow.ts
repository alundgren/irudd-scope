import type { Graph } from "@dagrejs/dagre";
import dagre from "@dagrejs/dagre";
import { escapeHtml } from "../html.ts";
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
import type { Tags } from "./text.ts";
import { cleanLabel, num, splitDetail, takeTags, wrapText } from "./text.ts";

const MAX_NODES = 60;
const MAX_EDGES = 150;
const ARROW = /<-->|<->|-->|->/;

type FlowEdge = { from: string; to: string; label: string; dashed: boolean; twoWay: boolean };
type Flow = {
  nodes: Map<string, PlateNode>;
  edges: FlowEdge[];
  groups: { name: string; members: string[] }[];
};

/**
 * `flow right|down`. Lines are edges (`A -> B: label`, chains, `A -> B, C` fan-out,
 * `-->` dashed, `<->` two-way), node lines (`Name | detail [tags]`) and groups
 * (`group Name: A, B`).
 */
export function renderFlow(header: Header, lines: readonly string[]): string | null {
  const flow = parseFlow(lines);
  if (flow.nodes.size === 0) return null;
  return layoutFlow(flow, header);
}

export function parseFlow(lines: readonly string[]): Flow {
  const flow: Flow = { nodes: new Map(), edges: [], groups: [] };
  for (const line of lines) {
    const group = /^group\s+([^:]+):(.*)$/i.exec(line);
    if (ARROW.test(line)) {
      parseEdgeLine(flow, line);
    } else if (group) {
      const members = nodeList(flow, group[2]!);
      if (members.length > 0) flow.groups.push({ name: cleanLabel(group[1]!), members });
    } else {
      nodeList(flow, line);
    }
  }
  return flow;
}

function parseEdgeLine(flow: Flow, line: string): void {
  const parts = line.split(/\s*(<-->|<->|-->|->)\s*/);
  let previous = nodeList(flow, parts[0]!);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const arrow = parts[i]!;
    const segment = parts[i + 1]!;
    const colon = segment.indexOf(":");
    const names = colon < 0 ? segment : segment.slice(0, colon);
    const label = colon < 0 ? "" : cleanLabel(segment.slice(colon + 1));
    const next = nodeList(flow, names);
    for (const from of previous) {
      for (const to of next) {
        if (flow.edges.length >= MAX_EDGES) return;
        flow.edges.push({
          from,
          to,
          label,
          dashed: arrow.includes("--"),
          twoWay: arrow.startsWith("<"),
        });
      }
    }
    previous = next;
  }
}

/** Adds or updates the comma-separated nodes in `text` and returns their keys. */
function nodeList(flow: Flow, text: string): string[] {
  const { text: names, tags } = takeTags(text);
  const keys: string[] = [];
  for (const part of names.split(",")) {
    const { head, detail } = splitDetail(part);
    const label = cleanLabel(head);
    if (!label) continue;
    const key = label.toLowerCase();
    const existing = flow.nodes.get(key);
    if (existing) mergeNode(existing, detail, tags);
    else if (flow.nodes.size < MAX_NODES) flow.nodes.set(key, { head: label, detail, tags });
    else continue;
    keys.push(key);
  }
  return keys;
}

function mergeNode(node: PlateNode, detail: string, tags: Tags): void {
  if (detail) node.detail = detail;
  for (const name of tags.names) node.tags.names.add(name);
  if (tags.series !== null) node.tags.series = tags.series;
}

function layoutFlow(flow: Flow, header: Header): string {
  const down = /^(down|td|tb|vertical)$/i.test(header.arg);
  const graph = new dagre.graphlib.Graph({ compound: flow.groups.length > 0, multigraph: true });
  graph.setGraph({
    rankdir: down ? "TB" : "LR",
    nodesep: down ? 28 : 22,
    ranksep: down ? 40 : 52,
    edgesep: 14,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const plates = new Map<string, Plate>();
  for (const [key, node] of flow.nodes) {
    const plate = measurePlate(node);
    plates.set(key, plate);
    graph.setNode(key, { width: plate.width, height: plate.height });
  }
  const placed = new Set<string>();
  flow.groups.forEach((group, index) => {
    const id = `group:${index}`;
    graph.setNode(id, {});
    for (const member of group.members) {
      if (placed.has(member)) continue;
      placed.add(member);
      graph.setParent(member, id);
    }
  });
  const edgeLabels = flow.edges.map((edge) => wrapText(edge.label, DETAIL_PX, 120));
  flow.edges.forEach((edge, index) => {
    const size = labelSize(edgeLabels[index]!);
    graph.setEdge(edge.from, edge.to, { ...size, labelpos: "c" }, `e${index}`);
  });
  dagre.layout(graph);
  return drawFlow(flow, graph, plates, edgeLabels, header);
}

function drawFlow(
  flow: Flow,
  graph: Graph,
  plates: Map<string, Plate>,
  edgeLabels: string[][],
  header: Header,
): string {
  const bounds = new Bounds();
  const parts: string[] = [];
  flow.groups.forEach((group, index) => {
    const box = graph.node(`group:${index}`);
    if (!box || !Number.isFinite(box.x)) return;
    const x = box.x - box.width / 2;
    // Dagre leaves a band above the members, which holds the label.
    const y = box.y - box.height / 2;
    const height = box.height;
    bounds.add(x, y, box.width, height);
    parts.push(
      `<g class="mc-group"><rect x="${num(x)}" y="${num(y)}" width="${num(box.width)}" height="${num(height)}" rx="10"/>` +
        `<text class="mc-g-label" x="${num(x + 10)}" y="${num(y + 13)}">${escapeHtml(group.name)}</text></g>`,
    );
  });
  flow.edges.forEach((edge, index) => {
    const laid = graph.edge({ v: edge.from, w: edge.to, name: `e${index}` });
    const points: Point[] = laid?.points ?? [];
    if (points.length < 2) return;
    for (const point of points) bounds.add(point.x, point.y);
    const size = labelSize(edgeLabels[index]!);
    if (laid.x !== undefined && laid.y !== undefined && size.width > 0) {
      bounds.add(laid.x - size.width / 2, laid.y - size.height / 2, size.width, size.height);
    }
    parts.push(drawEdge(edge, points, edgeLabels[index]!, laid));
  });
  for (const [key, plate] of plates) {
    const node = graph.node(key);
    if (!node) continue;
    bounds.add(node.x - plate.width / 2, node.y - plate.height / 2, plate.width, plate.height);
    parts.push(plateSvg(plate, node.x, node.y));
  }
  return svgDocument(parts.join(""), bounds, header.title || "Flow diagram");
}

function drawEdge(
  edge: FlowEdge,
  points: Point[],
  label: string[],
  laid: { x?: number; y?: number },
): string {
  const line = `<path class="mc-edge${edge.dashed ? " is-dashed" : ""}" d="${smoothPath(points)}"/>`;
  const end = arrowHead(points.at(-2)!, points.at(-1)!);
  const start = edge.twoWay ? arrowHead(points[1]!, points[0]!) : "";
  const text =
    label[0] && laid.x !== undefined && laid.y !== undefined ? labelSvg(label, laid.x, laid.y) : "";
  return `<g class="mc-link">${line}${end}${start}${text}</g>`;
}
