import dagre from "@dagrejs/dagre";
import { escapeHtml } from "../html.ts";
import type { Header } from "./header.ts";
import type { Point } from "./svg.ts";
import {
  Bounds,
  DETAIL_PX,
  endLabelSvg,
  HEAD_PX,
  labelSize,
  labelSvg,
  plateClass,
  smoothPath,
  svgDocument,
  svgText,
} from "./svg.ts";
import type { Tags } from "./text.ts";
import { cleanLabel, num, textWidth, wrapText } from "./text.ts";

const MAX_CLASSES = 30;
const MAX_MEMBERS = 30;
const MAX_RELATIONS = 80;
const PAD_X = 10;
const MIN_WIDTH = 110;
const MAX_TEXT = 190;
const STEREO_PX = 11;
const STEREO_LINE = 14;
const NAME_LINE = 16;
const NAME_PAD = 7;
const ROW_H = 17;
/** Extra height of each wrapped line of a long member. */
const WRAP_H = 15;
const WRAP_INDENT = 12;
const BOX_PAD = 5;
const EMPTY_H = 10;
const FIT_WIDTH = 700;
const LOOP_OUT = 34;

type RelationKind =
  | "inherit"
  | "realize"
  | "compose"
  | "aggregate"
  | "assoc"
  | "depend"
  | "link"
  | "dashed";

/** Arrow tokens, longest first. `reversed` arrows point the other way, so their ends swap. */
const ARROWS: { token: string; pattern: string; kind: RelationKind; reversed: boolean }[] = [
  { token: "<|--", pattern: String.raw`<\|--`, kind: "inherit", reversed: false },
  { token: "--|>", pattern: String.raw`--\|>`, kind: "inherit", reversed: true },
  { token: "<|..", pattern: String.raw`<\|\.\.`, kind: "realize", reversed: false },
  { token: "..|>", pattern: String.raw`\.\.\|>`, kind: "realize", reversed: true },
  { token: "*--", pattern: String.raw`\*--`, kind: "compose", reversed: false },
  { token: "--*", pattern: String.raw`--\*`, kind: "compose", reversed: true },
  { token: "o--", pattern: String.raw`(?<=\s)o--`, kind: "aggregate", reversed: false },
  { token: "--o", pattern: String.raw`--o(?=\s)`, kind: "aggregate", reversed: true },
  { token: "-->", pattern: String.raw`-->`, kind: "assoc", reversed: false },
  { token: "<--", pattern: String.raw`<--`, kind: "assoc", reversed: true },
  { token: "..>", pattern: String.raw`\.\.>`, kind: "depend", reversed: false },
  { token: "<..", pattern: String.raw`<\.\.`, kind: "depend", reversed: true },
  { token: "--", pattern: String.raw`(?<=\s)--(?=\s)`, kind: "link", reversed: false },
  { token: "..", pattern: String.raw`(?<=\s)\.\.(?=\s)`, kind: "dashed", reversed: false },
];
const RELATION = new RegExp(
  String.raw`^(.+?)\s*(?:"([^"]*)"\s*)?(${ARROWS.map((arrow) => arrow.pattern).join("|")})\s*(?:"([^"]*)"\s*)?(.+?)(?:\s*:\s*(.*))?$`,
);
const CLASS_TAGS = /^(?:interface|abstract|enum|key|muted|s[1-7])$/;
const STEREOTYPE = /<<\s*([^<>]*?)\s*>>|«\s*([^«»]*?)\s*»/;

type Member = { visibility: string; text: string };
type ClassBox = {
  name: string;
  stereotype: string;
  italic: boolean;
  tags: Tags;
  attributes: Member[];
  methods: Member[];
};
/** The marker end is `from`: the parent, interface or whole. Arrows of `assoc` and `depend` point at `to`. */
type Relation = {
  from: string;
  to: string;
  kind: RelationKind;
  fromMult: string;
  toMult: string;
  label: string;
};
type Model = { classes: Map<string, ClassBox>; relations: Relation[] };

/**
 * `class [right|down]`. Lines are classes (`Name: +id: int, -email: string, +send(): void`;
 * a member with `(` is a method), relations (`A <|-- B: label`, with `<|--` extends,
 * `<|..` implements, `*--` composition, `o--` aggregation, `-->` association, `..>`
 * dependency, and `"1"` or `"*"` multiplicities beside the arrow) and indented member
 * lines under the class above. `Name <<interface>>`, `[interface]`, `[abstract]` and
 * `[enum]` mark the class.
 */
export function renderClass(header: Header, lines: readonly string[]): string | null {
  const model = parseModel(lines);
  if (model.classes.size === 0) return null;
  return drawModel(model, header);
}

function parseModel(lines: readonly string[]): Model {
  const model: Model = { classes: new Map(), relations: [] };
  let last: ClassBox | null = null;
  for (const raw of lines) {
    const line = raw
      .trim()
      .replace(/^class\s+/i, "")
      .replace(/\s*\{\s*$/, "");
    if (!line) continue;
    const relation = RELATION.exec(line);
    if (relation) {
      addRelation(model, relation);
      last = null;
      continue;
    }
    const indented = /^\s/.test(raw) || /^[+\-#~]/.test(line) || /^(<<|«)/.test(line);
    if (last && indented) {
      addMembers(last, line);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      last = classFor(model, line.slice(0, colon));
      if (last) addMembers(last, line.slice(colon + 1));
    } else {
      last = classFor(model, line);
    }
  }
  return model;
}

function addRelation(model: Model, match: RegExpExecArray): void {
  const arrow = ARROWS.find((known) => known.token === match[3]);
  const left = classFor(model, match[1]!);
  const right = classFor(model, match[5]!);
  if (!arrow || !left || !right || model.relations.length >= MAX_RELATIONS) return;
  const leftMult = cleanLabel(match[2] ?? "");
  const rightMult = cleanLabel(match[4] ?? "");
  const [from, to, fromMult, toMult] = arrow.reversed
    ? [right, left, rightMult, leftMult]
    : [left, right, leftMult, rightMult];
  const fromKey = from.name.toLowerCase();
  const toKey = to.name.toLowerCase();
  const same = model.relations.find(
    (known) => known.from === fromKey && known.to === toKey && known.kind === arrow.kind,
  );
  if (same) {
    same.label ||= cleanLabel(match[6] ?? "");
    same.fromMult ||= fromMult;
    same.toMult ||= toMult;
    return;
  }
  model.relations.push({
    from: fromKey,
    to: toKey,
    kind: arrow.kind,
    fromMult,
    toMult,
    label: cleanLabel(match[6] ?? ""),
  });
}

/** Adds or updates a class from `Name <<stereotype>> [tags]` and returns it. */
function classFor(model: Model, text: string): ClassBox | null {
  let rest = text.trim();
  const names = new Set<string>();
  for (;;) {
    const match = /\s*\[([^\][]*)\]$/.exec(rest);
    if (!match || match.index === 0) break;
    const group = match[1]!
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (group.length === 0 || !group.every((tag) => CLASS_TAGS.test(tag))) break;
    for (const tag of group) names.add(tag);
    rest = rest.slice(0, match.index).trimEnd();
  }
  let stereotype = "";
  const found = STEREOTYPE.exec(rest);
  if (found) {
    stereotype = cleanLabel(found[1] ?? found[2] ?? "");
    rest = rest.replace(STEREOTYPE, " ");
  }
  // Mermaid writes generics as `List~T~`.
  const name = cleanLabel(rest.replace(/~([^~]*)~/g, "<$1>"));
  if (!name) return null;
  const key = name.toLowerCase();
  let box = model.classes.get(key);
  if (!box) {
    if (model.classes.size >= MAX_CLASSES) return null;
    box = {
      name,
      stereotype: "",
      italic: false,
      tags: { names: new Set(), series: null },
      attributes: [],
      methods: [],
    };
    model.classes.set(key, box);
  }
  if (names.has("interface")) stereotype ||= "interface";
  if (names.has("enum")) stereotype ||= "enumeration";
  if (stereotype) setStereotype(box, stereotype);
  if (names.has("abstract")) box.italic = true;
  for (const tag of names) {
    const series = /^s([1-7])$/.exec(tag);
    if (series) box.tags.series = Number(series[1]);
    else box.tags.names.add(tag);
  }
  return box;
}

function setStereotype(box: ClassBox, stereotype: string): void {
  box.stereotype = stereotype;
  if (/^(interface|abstract)$/i.test(stereotype)) box.italic = true;
}

/** Adds comma-separated members, splitting only outside brackets so `f(a, b)` stays whole. */
function addMembers(box: ClassBox, text: string): void {
  for (const part of splitMembers(text)) {
    const member = cleanLabel(part.replace(/~([^~]*)~/g, "<$1>"));
    if (!member) continue;
    const stereotype = STEREOTYPE.exec(member);
    if (stereotype && member.replace(STEREOTYPE, "").trim() === "") {
      setStereotype(box, cleanLabel(stereotype[1] ?? stereotype[2] ?? ""));
      continue;
    }
    const list = member.includes("(") ? box.methods : box.attributes;
    if (list.length >= MAX_MEMBERS) continue;
    const visible = /^([+\-#~])\s*/.exec(member);
    const entry = {
      visibility: visible?.[1] ?? "",
      text: visible ? member.slice(visible[0].length) : member,
    };
    if (!entry.text) continue;
    if (!list.some((known) => known.text === entry.text)) list.push(entry);
  }
}

function splitMembers(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("([<{".includes(char)) depth += 1;
    else if (")]>}".includes(char)) depth = Math.max(0, depth - 1);
    if ((char === "," || char === ";") && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

type Box = {
  cls: ClassBox;
  name: string[];
  attributes: MemberLines[];
  methods: MemberLines[];
  width: number;
  height: number;
  nameH: number;
  attrH: number;
};

/** A member's text wrapped to the box; later lines are indented under the first. */
type MemberLines = { visibility: string; lines: string[] };

function visibilityWidth(member: { visibility: string }): number {
  return member.visibility ? textWidth(`${member.visibility} `, DETAIL_PX) : 0;
}

function wrapMember(member: Member): MemberLines {
  const room = MAX_TEXT - visibilityWidth(member);
  const [first = "", ...rest] = wrapText(member.text, DETAIL_PX, room);
  const more = rest.join(" ");
  const lines = more ? [first, ...wrapText(more, DETAIL_PX, room - WRAP_INDENT)] : [first];
  return { visibility: member.visibility, lines: lines.slice(0, 4) };
}

function memberWidth(member: MemberLines): number {
  return Math.max(
    ...member.lines.map(
      (line, index) =>
        visibilityWidth(member) + (index > 0 ? WRAP_INDENT : 0) + textWidth(line, DETAIL_PX),
    ),
  );
}

function rowsHeight(members: readonly MemberLines[]): number {
  if (members.length === 0) return EMPTY_H;
  const wrapped = members.reduce((sum, member) => sum + member.lines.length - 1, 0);
  return BOX_PAD * 2 + members.length * ROW_H + wrapped * WRAP_H;
}

function measureBox(cls: ClassBox): Box {
  const name = wrapText(cls.name, HEAD_PX, MAX_TEXT);
  const attributes = cls.attributes.map(wrapMember);
  const methods = cls.methods.map(wrapMember);
  const stereo = cls.stereotype ? `«${cls.stereotype}»` : "";
  const textW = Math.max(
    ...name.map((line) => textWidth(line, HEAD_PX)),
    stereo ? textWidth(stereo, STEREO_PX) : 0,
    ...attributes.map(memberWidth),
    ...methods.map(memberWidth),
  );
  const width = Math.max(MIN_WIDTH, textW + PAD_X * 2);
  const nameH = NAME_PAD * 2 + (stereo ? STEREO_LINE : 0) + name.length * NAME_LINE;
  const attrH = rowsHeight(attributes);
  const height = nameH + attrH + rowsHeight(methods);
  return { cls, name, attributes, methods, width, height, nameH, attrH };
}

function layoutModel(model: Model, down: boolean, boxes: Map<string, Box>, labels: string[][]) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: down ? "TB" : "LR",
    nodesep: down ? 36 : 28,
    ranksep: down ? 56 : 80,
    edgesep: 18,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  // A relation from a class to itself is drawn as a loop above it. The layout box grows
  // by the same amount above and below, so other edges still meet the box sides.
  const loopRoom = new Map<string, number>();
  model.relations.forEach((relation, index) => {
    if (relation.from !== relation.to) return;
    const room = LOOP_OUT + 8 + labelSize(labels[index]!).height;
    loopRoom.set(relation.from, Math.max(loopRoom.get(relation.from) ?? 0, room));
  });
  for (const [key, box] of boxes) {
    graph.setNode(key, { width: box.width, height: box.height + 2 * (loopRoom.get(key) ?? 0) });
  }
  model.relations.forEach((relation, index) => {
    if (relation.from === relation.to) return;
    const size = labelSize(labels[index]!);
    graph.setEdge(relation.from, relation.to, { ...size, labelpos: "c" }, `r${index}`);
  });
  dagre.layout(graph);
  return graph;
}

function drawModel(model: Model, header: Header): string {
  const boxes = new Map<string, Box>();
  for (const [key, cls] of model.classes) boxes.set(key, measureBox(cls));
  const labels = model.relations.map((relation) => wrapText(relation.label, DETAIL_PX, 110));
  let graph = layoutModel(model, /^(down|td|tb|vertical)$/i.test(header.arg), boxes, labels);
  // Wide models laid out left to right shrink to unreadable text in a section.
  if (!header.arg.trim() && (graph.graph().width ?? 0) > FIT_WIDTH)
    graph = layoutModel(model, true, boxes, labels);

  const bounds = new Bounds();
  const links: string[] = [];
  model.relations.forEach((relation, index) => {
    if (relation.from === relation.to) {
      const node = graph.node(relation.from);
      const box = boxes.get(relation.from);
      if (node && box)
        links.push(selfLoopSvg(relation, labels[index]!, node.x, node.y - box.height / 2, bounds));
      return;
    }
    const laid = graph.edge({ v: relation.from, w: relation.to, name: `r${index}` });
    const points: Point[] = laid?.points ?? [];
    if (points.length < 2) return;
    for (const point of points) bounds.add(point.x, point.y);
    links.push(relationSvg(relation, points, labels[index]!, laid, bounds));
  });
  const plates: string[] = [];
  for (const [key, box] of boxes) {
    const node = graph.node(key);
    if (!node) continue;
    const x = node.x - box.width / 2;
    const y = node.y - box.height / 2;
    bounds.add(x, y, box.width, box.height);
    plates.push(boxSvg(box, x, y));
  }
  return svgDocument(links.join("") + plates.join(""), bounds, header.title || "Class diagram");
}

function relationSvg(
  relation: Relation,
  points: Point[],
  label: string[],
  laid: { x?: number; y?: number },
  bounds: Bounds,
): string {
  const dashed =
    relation.kind === "realize" || relation.kind === "depend" || relation.kind === "dashed";
  const parts = [`<path class="mc-edge${dashed ? " is-dashed" : ""}" d="${smoothPath(points)}"/>`];
  const start = points[0]!;
  const end = points.at(-1)!;
  const fromMark = markerSvg(relation.kind, start, points[1]!);
  const toMark =
    relation.kind === "assoc" || relation.kind === "depend" ? openArrow(end, points.at(-2)!) : "";
  parts.push(fromMark.svg, toMark);
  if (relation.fromMult) {
    const tip = along(start, points[1]!, fromMark.length);
    parts.push(endLabelSvg(relation.fromMult, tip, points[1]!, -1, bounds, "mc-cls-mult"));
  }
  if (relation.toMult) {
    const tip = along(end, points.at(-2)!, toMark ? 6 : 0);
    parts.push(endLabelSvg(relation.toMult, tip, points.at(-2)!, 1, bounds, "mc-cls-mult"));
  }
  if (label[0] && laid.x !== undefined && laid.y !== undefined) {
    const size = labelSize(label);
    bounds.add(laid.x - size.width / 2, laid.y - size.height / 2, size.width, size.height);
    parts.push(labelSvg(label, laid.x, laid.y));
  }
  return `<g class="mc-link mc-cls-link is-${relation.kind}">${parts.join("")}</g>`;
}

/** The point `distance` from `tip` toward `toward`. */
function along(tip: Point, toward: Point, distance: number): Point {
  const length = Math.hypot(toward.x - tip.x, toward.y - tip.y) || 1;
  return {
    x: tip.x + ((toward.x - tip.x) / length) * distance,
    y: tip.y + ((toward.y - tip.y) / length) * distance,
  };
}

/** Points left and right of the line at `distance` back from `tip`, `half` apart from it. */
function sides(tip: Point, toward: Point, distance: number, half: number): [Point, Point] {
  const back = along(tip, toward, distance);
  const length = Math.hypot(toward.x - tip.x, toward.y - tip.y) || 1;
  const nx = -(toward.y - tip.y) / length;
  const ny = (toward.x - tip.x) / length;
  return [
    { x: back.x + nx * half, y: back.y + ny * half },
    { x: back.x - nx * half, y: back.y - ny * half },
  ];
}

const pt = (point: Point) => `${num(point.x)} ${num(point.y)}`;

/** The UML mark at the `from` end: a hollow triangle for extends and implements, a diamond for wholes. */
function markerSvg(kind: RelationKind, tip: Point, toward: Point): { svg: string; length: number } {
  if (kind === "inherit" || kind === "realize") {
    const [left, right] = sides(tip, toward, 13, 7);
    return {
      svg: `<path class="mc-cls-mark is-hollow" d="M${pt(tip)}L${pt(left)}L${pt(right)}Z"/>`,
      length: 13,
    };
  }
  if (kind === "compose" || kind === "aggregate") {
    const [left, right] = sides(tip, toward, 8, 5.5);
    const back = along(tip, toward, 16);
    const fill = kind === "compose" ? "is-filled" : "is-hollow";
    return {
      svg: `<path class="mc-cls-mark ${fill}" d="M${pt(tip)}L${pt(left)}L${pt(back)}L${pt(right)}Z"/>`,
      length: 16,
    };
  }
  return { svg: "", length: 0 };
}

/** An open arrowhead for navigable associations and dependencies. */
function openArrow(tip: Point, toward: Point): string {
  const [left, right] = sides(tip, toward, 9, 5);
  return `<path class="mc-edge mc-cls-open" d="M${pt(left)}L${pt(tip)}L${pt(right)}"/>`;
}

function selfLoopSvg(
  relation: Relation,
  label: string[],
  centerX: number,
  top: number,
  bounds: Bounds,
): string {
  const left = { x: centerX - 18, y: top };
  const right = { x: centerX + 18, y: top };
  const peak = top - LOOP_OUT;
  const d = `M${pt(left)}C${num(left.x - 12)} ${num(peak)} ${num(right.x + 12)} ${num(peak)} ${pt(right)}`;
  bounds.add(left.x - 14, peak, right.x - left.x + 28, LOOP_OUT);
  const dashed =
    relation.kind === "realize" || relation.kind === "depend" || relation.kind === "dashed";
  const parts = [`<path class="mc-edge${dashed ? " is-dashed" : ""}" d="${d}"/>`];
  parts.push(markerSvg(relation.kind, left, { x: left.x - 6, y: top - 12 }).svg);
  if (relation.kind === "assoc" || relation.kind === "depend")
    parts.push(openArrow(right, { x: right.x + 6, y: top - 12 }));
  if (relation.fromMult)
    parts.push(
      endLabelSvg(
        relation.fromMult,
        left,
        { x: left.x - 4, y: top - 10 },
        1,
        bounds,
        "mc-cls-mult",
      ),
    );
  if (relation.toMult)
    parts.push(
      endLabelSvg(
        relation.toMult,
        right,
        { x: right.x + 4, y: top - 10 },
        -1,
        bounds,
        "mc-cls-mult",
      ),
    );
  if (label[0]) {
    const size = labelSize(label);
    // The curve's highest point is three quarters of the way to its control points.
    const cy = top - LOOP_OUT * 0.75 - 3 - size.height / 2;
    bounds.add(centerX - size.width / 2, cy - size.height / 2, size.width, size.height);
    parts.push(labelSvg(label, centerX, cy));
  }
  return `<g class="mc-link mc-cls-link is-${relation.kind}">${parts.join("")}</g>`;
}

/** A member's lines from `top`; returns the markup and the height used. */
function memberSvg(member: MemberLines, x: number, top: number, method: boolean): string {
  const className = `mc-cls-member${method ? " is-method" : ""}`;
  const indent = visibilityWidth(member);
  return member.lines
    .map((line, index) => {
      const y = top + ROW_H / 2 + index * WRAP_H;
      if (index > 0) return svgText(line, x + indent + WRAP_INDENT, y, className, "start");
      const visibility = member.visibility
        ? `<tspan class="mc-cls-vis">${escapeHtml(member.visibility)}</tspan> `
        : "";
      return `<text class="${className}" x="${num(x)}" y="${num(y)}" text-anchor="start" dominant-baseline="central">${visibility}${escapeHtml(line)}</text>`;
    })
    .join("");
}

function membersSvg(members: readonly MemberLines[], x: number, top: number, method: boolean) {
  let y = top + BOX_PAD;
  return members
    .map((member) => {
      const svg = memberSvg(member, x, y, method);
      y += ROW_H + (member.lines.length - 1) * WRAP_H;
      return svg;
    })
    .join("");
}

function boxSvg(box: Box, x: number, y: number): string {
  const { width: w, height: h, nameH, attrH, cls } = box;
  const parts = [
    `<rect class="mc-plate" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="4"/>`,
    `<path class="mc-cls-head" d="M${num(x + 0.5)} ${num(y + nameH)}V${num(y + 4)}A3.5 3.5 0 0 1 ${num(x + 4)} ${num(y + 0.5)}H${num(x + w - 4)}A3.5 3.5 0 0 1 ${num(x + w - 0.5)} ${num(y + 4)}V${num(y + nameH)}Z"/>`,
  ];
  let cy = y + NAME_PAD;
  if (cls.stereotype) {
    parts.push(svgText(`«${cls.stereotype}»`, x + w / 2, cy + STEREO_LINE / 2, "mc-cls-stereo"));
    cy += STEREO_LINE;
  }
  const nameClass = `mc-n-head is-strong${cls.italic ? " mc-cls-italic" : ""}`;
  box.name.forEach((line, index) => {
    parts.push(svgText(line, x + w / 2, cy + NAME_LINE * (index + 0.5), nameClass));
  });
  parts.push(`<path class="mc-plate-line" d="M${num(x)} ${num(y + nameH)}H${num(x + w)}"/>`);
  parts.push(
    `<path class="mc-plate-line" d="M${num(x)} ${num(y + nameH + attrH)}H${num(x + w)}"/>`,
  );
  parts.push(membersSvg(box.attributes, x + PAD_X, y + nameH, false));
  parts.push(membersSvg(box.methods, x + PAD_X, y + nameH + attrH, true));
  return `<g class="${plateClass(cls.tags, "mc-cls-box")}" aria-label="${escapeHtml(cls.name)}">${parts.join("")}</g>`;
}
