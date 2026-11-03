import { escapeHtml } from "../html.ts";
import type { Tags } from "./text.ts";
import { num, textWidth, wrapText } from "./text.ts";

/** Font sizes in SVG user units; page.css uses the same values. */
export const HEAD_PX = 12.5;
export const DETAIL_PX = 11.5;
const HEAD_LINE = 16;
const DETAIL_LINE = 15;
const PAD_X = 12;
const PAD_Y = 8;
const MAX_TEXT = 156;
const MIN_WIDTH = 64;

export type PlateNode = { head: string; detail: string; tags: Tags };
export type Plate = {
  node: PlateNode;
  outline: "box" | "pill" | "db" | "diamond";
  head: string[];
  detail: string[];
  width: number;
  height: number;
};

export function measurePlate(node: PlateNode, maxText = MAX_TEXT): Plate {
  const outline = plateOutline(node.tags);
  const limit = outline === "diamond" ? Math.min(maxText, 112) : maxText;
  const head = wrapText(node.head, HEAD_PX, limit);
  const detail = node.detail ? wrapText(node.detail, DETAIL_PX, limit) : [];
  const textW = Math.max(
    ...head.map((line) => textWidth(line, HEAD_PX)),
    ...detail.map((line) => textWidth(line, DETAIL_PX)),
  );
  const textH = head.length * HEAD_LINE + detail.length * DETAIL_LINE;
  let width = Math.max(MIN_WIDTH, textW + PAD_X * 2);
  let height = textH + PAD_Y * 2;
  if (outline === "diamond") {
    width = Math.max(MIN_WIDTH, textW * 1.8 + 16);
    height = textH * 2 + 12;
  } else if (outline === "db") {
    height += 12;
  } else if (outline === "pill") {
    width += 10;
  }
  return { node, outline, head, detail, width, height };
}

function plateOutline(tags: Tags): Plate["outline"] {
  if (tags.names.has("decision")) return "diamond";
  if (tags.names.has("db")) return "db";
  if (tags.names.has("start") || tags.names.has("end")) return "pill";
  return "box";
}

export function plateClass(tags: Tags, extra = ""): string {
  const names = ["mc-node"];
  if (tags.names.has("key") || tags.names.has("start") || tags.names.has("end")) {
    names.push("is-key");
  }
  if (tags.names.has("muted")) names.push("is-muted");
  if (tags.series !== null) names.push(`is-toned mc-s${tags.series}`);
  if (extra) names.push(extra);
  return names.join(" ");
}

/**
 * A node plate centred on (cx, cy): outline plus head and detail lines. `radius`
 * overrides the corner radius of box outlines.
 */
export function plateSvg(
  plate: Plate,
  cx: number,
  cy: number,
  extraClass = "",
  radius?: number,
): string {
  const { width: w, height: h } = plate;
  const x = cx - w / 2;
  const y = cy - h / 2;
  let frame: string;
  if (plate.outline === "diamond") {
    frame = `<path class="mc-plate" d="M${num(cx)} ${num(y)}L${num(x + w)} ${num(cy)}L${num(cx)} ${num(y + h)}L${num(x)} ${num(cy)}Z"/>`;
  } else if (plate.outline === "db") {
    const rim = 6;
    frame =
      `<path class="mc-plate" d="M${num(x)} ${num(y + rim)}A${num(w / 2)} ${rim} 0 0 1 ${num(x + w)} ${num(y + rim)}` +
      `V${num(y + h - rim)}A${num(w / 2)} ${rim} 0 0 1 ${num(x)} ${num(y + h - rim)}Z"/>` +
      `<path class="mc-plate-line" d="M${num(x)} ${num(y + rim)}A${num(w / 2)} ${rim} 0 0 0 ${num(x + w)} ${num(y + rim)}"/>`;
  } else {
    const corner = plate.outline === "pill" ? h / 2 : (radius ?? 6);
    frame = `<rect class="mc-plate" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(Math.min(corner, h / 2))}"/>`;
  }
  return `<g class="${plateClass(plate.node.tags, extraClass)}">${frame}${plateText(plate, cx, cy)}</g>`;
}

function plateText(plate: Plate, cx: number, cy: number): string {
  const total = plate.head.length * HEAD_LINE + plate.detail.length * DETAIL_LINE;
  const top = cy - total / 2 + (plate.outline === "db" ? 4 : 0);
  const headClass = plate.detail.length > 0 ? "mc-n-head is-strong" : "mc-n-head";
  const lines = plate.head.map((line, index) =>
    svgText(line, cx, top + HEAD_LINE * (index + 0.5), headClass),
  );
  const detailTop = top + plate.head.length * HEAD_LINE;
  plate.detail.forEach((line, index) =>
    lines.push(svgText(line, cx, detailTop + DETAIL_LINE * (index + 0.5), "mc-n-detail")),
  );
  return lines.join("");
}

export function svgText(text: string, x: number, y: number, className: string, anchor = "middle") {
  return `<text class="${className}" x="${num(x)}" y="${num(y)}" text-anchor="${anchor}" dominant-baseline="central">${escapeHtml(text)}</text>`;
}

export type Point = { x: number; y: number };

/** A path through `points`, rounded at the bends. */
export function smoothPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  let d = `M${num(first!.x)} ${num(first!.y)}`;
  for (let i = 0; i < rest.length - 1; i += 1) {
    const bend = rest[i]!;
    const next = rest[i + 1]!;
    d += `Q${num(bend.x)} ${num(bend.y)} ${num((bend.x + next.x) / 2)} ${num((bend.y + next.y) / 2)}`;
  }
  const last = rest.at(-1);
  if (last) d += `L${num(last.x)} ${num(last.y)}`;
  return d;
}

/** A filled arrowhead with its tip at `tip`, pointing away from `from`. */
export function arrowHead(from: Point, tip: Point): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const back = { x: tip.x - ux * 7, y: tip.y - uy * 7 };
  const left = { x: back.x - uy * 3.5, y: back.y + ux * 3.5 };
  const right = { x: back.x + uy * 3.5, y: back.y - ux * 3.5 };
  return `<path class="mc-arrow" d="M${num(tip.x)} ${num(tip.y)}L${num(left.x)} ${num(left.y)}L${num(right.x)} ${num(right.y)}Z"/>`;
}

/** A small surface-coloured label plate for edges and messages. */
export function labelSvg(lines: readonly string[], cx: number, cy: number): string {
  const { width, height } = labelSize(lines);
  if (width === 0) return "";
  const top = cy - height / 2 + 2;
  const text = lines
    .map((line, index) => svgText(line, cx, top + DETAIL_LINE * (index + 0.5), "mc-e-label"))
    .join("");
  return `<g class="mc-edge-label"><rect class="mc-label-plate" x="${num(cx - width / 2)}" y="${num(cy - height / 2)}" width="${num(width)}" height="${num(height)}" rx="4"/>${text}</g>`;
}

export function labelSize(lines: readonly string[]): { width: number; height: number } {
  if (lines.length === 0 || (lines.length === 1 && !lines[0])) return { width: 0, height: 0 };
  return {
    width: Math.max(...lines.map((line) => textWidth(line, DETAIL_PX))) + 10,
    height: lines.length * DETAIL_LINE + 4,
  };
}

export { DETAIL_LINE, HEAD_LINE };

/** Tracks the drawn area so the viewBox fits every element. */
export class Bounds {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  add(x: number, y: number, width = 0, height = 0): void {
    if (![x, y, width, height].every(Number.isFinite)) return;
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x + width);
    this.maxY = Math.max(this.maxY, y + height);
  }
}

/**
 * Wraps drawn elements in an SVG whose viewBox fits `bounds`. The natural width goes
 * in a custom property so page.css can scale it to the block, or up in Present.
 */
export function svgDocument(body: string, bounds: Bounds, label: string, pad = 8): string {
  const x = bounds.minX - pad;
  const y = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;
  return `<svg class="mc-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" style="--mc-svg-w:${num(w)}px" role="img" aria-label="${escapeHtml(label)}">${body}</svg>`;
}
