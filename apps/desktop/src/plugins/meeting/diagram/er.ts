import dagre from "@dagrejs/dagre";
import { escapeHtml } from "../html.ts";
import type { Header } from "./header.ts";
import type { Point } from "./svg.ts";
import {
  Bounds,
  DETAIL_PX,
  HEAD_PX,
  labelSize,
  labelSvg,
  smoothPath,
  svgDocument,
  svgText,
} from "./svg.ts";
import { cleanLabel, num, textWidth, wrapText } from "./text.ts";

const MAX_ENTITIES = 30;
const MAX_FIELDS = 30;
const MAX_RELATIONS = 80;
const HEAD_H = 28;
const ROW_H = 20;
const PAD_X = 10;
const BADGE_W = 20;
const BADGE_GAP = 4;
const TYPE_GAP = 14;
const MIN_WIDTH = 120;
const MAX_TEXT = 150;
const CARD = String.raw`(?:0\.\.1|0\.\.\*|1\.\.\*|0\.\.n|1\.\.n|1|\*|n|m)`;
const RELATION = new RegExp(
  String.raw`^(.+?)\s+(${CARD})\s*--\s*(${CARD})\s+(.+?)\s*(?::\s*(.*))?$`,
  "i",
);

type Field = { name: string; type: string; pk: boolean; fk: boolean };
type Entity = { name: string; fields: Field[] };
type Relation = { from: string; to: string; fromCard: string; toCard: string; label: string };
type Model = { entities: Map<string, Entity>; relations: Relation[] };

/**
 * `er`. Lines are entities (`User: id pk, email text, team_id fk`; a word after a
 * field name is its type) and relations (`User *--1 Team: belongs to`, with `1`,
 * `*`, `0..1`, `0..*` or `1..*` at each end). Indented lines add fields to the
 * entity above.
 */
export function renderEr(header: Header, lines: readonly string[]): string | null {
  const model = parseModel(lines);
  if (model.entities.size === 0) return null;
  return drawModel(model, header);
}

function parseModel(lines: readonly string[]): Model {
  const model: Model = { entities: new Map(), relations: [] };
  let last: Entity | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const relation = RELATION.exec(line);
    if (relation) {
      addRelation(model, relation);
      last = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      last = entityFor(model, line.slice(0, colon));
      if (last) addFields(last, line.slice(colon + 1));
    } else if (last && /^\s/.test(raw)) {
      addFields(last, line);
    } else {
      last = entityFor(model, line);
    }
  }
  return model;
}

function addRelation(model: Model, match: RegExpExecArray): void {
  const from = entityFor(model, match[1]!);
  const to = entityFor(model, match[4]!);
  if (!from || !to || model.relations.length >= MAX_RELATIONS) return;
  model.relations.push({
    from: from.name.toLowerCase(),
    to: to.name.toLowerCase(),
    fromCard: match[2]!,
    toCard: match[3]!,
    label: cleanLabel(match[5] ?? ""),
  });
}

function entityFor(model: Model, text: string): Entity | null {
  const name = cleanLabel(text);
  if (!name) return null;
  const key = name.toLowerCase();
  const existing = model.entities.get(key);
  if (existing) return existing;
  if (model.entities.size >= MAX_ENTITIES) return null;
  const entity = { name, fields: [] };
  model.entities.set(key, entity);
  return entity;
}

/** Adds `name [type] [pk] [fk]` fields, split on commas outside parentheses. */
function addFields(entity: Entity, text: string): void {
  for (const part of text.split(/,(?![^(]*\))/)) {
    const words = cleanLabel(part).split(" ").filter(Boolean);
    const name = words.shift();
    if (!name || entity.fields.length >= MAX_FIELDS) continue;
    const flags = new Set(words.map((word) => word.toLowerCase()));
    const type = words.filter((word) => !/^(pk|fk)$/i.test(word)).join(" ");
    const field = { name, type, pk: flags.has("pk"), fk: flags.has("fk") };
    const index = entity.fields.findIndex((known) => known.name === name);
    if (index >= 0) entity.fields[index] = field;
    else entity.fields.push(field);
  }
}

type Table = {
  entity: Entity;
  name: string[];
  width: number;
  height: number;
  badges: number;
  rows: { name: string; type: string; field: Field }[];
};

function measureTable(entity: Entity): Table {
  const name = wrapText(entity.name, HEAD_PX, MAX_TEXT);
  const badges = Math.max(0, ...entity.fields.map((field) => Number(field.pk) + Number(field.fk)));
  const badgeW = badges * (BADGE_W + BADGE_GAP);
  const rows = entity.fields.map((field) => ({
    field,
    name: clip(field.name, MAX_TEXT),
    type: clip(field.type, 90),
  }));
  const rowW = Math.max(
    0,
    ...rows.map(
      (row) =>
        badgeW +
        textWidth(row.name, DETAIL_PX) +
        (row.type ? TYPE_GAP + textWidth(row.type, DETAIL_PX - 1) : 0),
    ),
  );
  const nameW = Math.max(...name.map((line) => textWidth(line, HEAD_PX)));
  const width = Math.max(MIN_WIDTH, nameW + PAD_X * 2, rowW + PAD_X * 2);
  const headH = HEAD_H + (name.length - 1) * 16;
  const height = headH + rows.length * ROW_H + (rows.length > 0 ? 6 : 0);
  return { entity, name, width, height, badges, rows };
}

/** Shortens text to fit `maxPx` with an ellipsis. */
function clip(text: string, maxPx: number): string {
  if (textWidth(text, DETAIL_PX) <= maxPx) return text;
  let out = "";
  for (const char of text) {
    if (textWidth(`${out}${char}…`, DETAIL_PX) > maxPx) break;
    out += char;
  }
  return `${out}…`;
}

function drawModel(model: Model, header: Header): string {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 90, edgesep: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  const tables = new Map<string, Table>();
  for (const [key, entity] of model.entities) {
    const table = measureTable(entity);
    tables.set(key, table);
    graph.setNode(key, { width: table.width, height: table.height });
  }
  const labels = model.relations.map((relation) => wrapText(relation.label, DETAIL_PX, 110));
  model.relations.forEach((relation, index) => {
    const size = labelSize(labels[index]!);
    graph.setEdge(relation.from, relation.to, { ...size, labelpos: "c" }, `r${index}`);
  });
  dagre.layout(graph);

  const bounds = new Bounds();
  const links: string[] = [];
  model.relations.forEach((relation, index) => {
    const laid = graph.edge({ v: relation.from, w: relation.to, name: `r${index}` });
    const points: Point[] = laid?.points ?? [];
    if (points.length < 2) return;
    for (const point of points) bounds.add(point.x, point.y);
    const parts = [`<path class="mc-edge" d="${smoothPath(points)}"/>`];
    parts.push(cardLabel(relation.fromCard, points[0]!, points[1]!, -1, bounds));
    parts.push(cardLabel(relation.toCard, points.at(-1)!, points.at(-2)!, 1, bounds));
    const label = labels[index]!;
    if (label[0] && laid.x !== undefined && laid.y !== undefined) {
      const size = labelSize(label);
      bounds.add(laid.x - size.width / 2, laid.y - size.height / 2, size.width, size.height);
      parts.push(labelSvg(label, laid.x, laid.y));
    }
    links.push(`<g class="mc-link mc-er-link">${parts.join("")}</g>`);
  });
  const plates: string[] = [];
  for (const [key, table] of tables) {
    const node = graph.node(key);
    if (!node) continue;
    const x = node.x - table.width / 2;
    const y = node.y - table.height / 2;
    bounds.add(x, y, table.width, table.height);
    plates.push(tableSvg(table, x, y));
  }
  return svgDocument(links.join("") + plates.join(""), bounds, header.title || "Data model");
}

/**
 * A cardinality mark just off the edge, near the end at `tip`. `side` flips the
 * offset so marks at both ends of an edge sit on the same side of it.
 */
function cardLabel(card: string, tip: Point, toward: Point, side: 1 | -1, bounds: Bounds): string {
  const dx = toward.x - tip.x;
  const dy = toward.y - tip.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const cx = tip.x + ux * 14 - uy * 9 * side;
  const cy = tip.y + uy * 14 + ux * 9 * side;
  const size = labelSize([card]);
  bounds.add(cx - size.width / 2, cy - size.height / 2, size.width, size.height);
  return labelSvg([card], cx, cy).replace(
    'class="mc-edge-label"',
    'class="mc-edge-label mc-er-card"',
  );
}

function tableSvg(table: Table, x: number, y: number): string {
  const { width: w, height: h } = table;
  const headH = HEAD_H + (table.name.length - 1) * 16;
  const parts = [
    `<rect class="mc-plate" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="8"/>`,
    `<path class="mc-er-head" d="M${num(x + 0.5)} ${num(y + headH)}V${num(y + 8)}A7.5 7.5 0 0 1 ${num(x + 8)} ${num(y + 0.5)}H${num(x + w - 8)}A7.5 7.5 0 0 1 ${num(x + w - 0.5)} ${num(y + 8)}V${num(y + headH)}Z"/>`,
  ];
  table.name.forEach((line, index) => {
    parts.push(svgText(line, x + w / 2, y + 14 + index * 16, "mc-n-head is-strong"));
  });
  if (table.rows.length > 0) {
    parts.push(`<path class="mc-plate-line" d="M${num(x)} ${num(y + headH)}H${num(x + w)}"/>`);
  }
  const badgeW = table.badges * (BADGE_W + BADGE_GAP);
  table.rows.forEach((row, index) => {
    const cy = y + headH + 3 + ROW_H * (index + 0.5);
    let bx = x + PAD_X;
    for (const kind of ["pk", "fk"] as const) {
      if (!row.field[kind]) continue;
      parts.push(
        `<g class="mc-er-badge is-${kind}"><rect x="${num(bx)}" y="${num(cy - 6.5)}" width="${BADGE_W}" height="13" rx="3"/>` +
          `<text x="${num(bx + BADGE_W / 2)}" y="${num(cy + 0.5)}" text-anchor="middle" dominant-baseline="central">${kind.toUpperCase()}</text></g>`,
      );
      bx += BADGE_W + BADGE_GAP;
    }
    const nameClass = row.field.pk ? "mc-er-field is-pk" : "mc-er-field";
    parts.push(svgText(row.name, x + PAD_X + badgeW, cy, nameClass, "start"));
    if (row.type) parts.push(svgText(row.type, x + w - PAD_X, cy, "mc-er-type", "end"));
  });
  return `<g class="mc-node mc-er-entity" aria-label="${escapeHtml(table.entity.name)}">${parts.join("")}</g>`;
}
