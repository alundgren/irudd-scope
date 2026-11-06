import type { Header } from "./header.ts";
import type { Plate } from "./svg.ts";
import { Bounds, measurePlate, plateSvg, svgDocument } from "./svg.ts";
import { cleanLabel, num, splitDetail, takeTags } from "./text.ts";

const MAX_NODES = 80;
const COLUMN_GAP = 40;
const ROW_GAP = 10;

type TreeNode = { plate: Plate; children: TreeNode[]; depth: number; y: number };

/**
 * `tree`. Indented lines, two spaces per level; the first line is the root. Leading
 * bullets (`- `, `* `) and box-drawing prefixes (`├── `) count as indentation.
 */
export function renderTree(header: Header, lines: readonly string[]): string | null {
  const root = parseTree(lines);
  if (!root) return null;
  return drawTree(root, header);
}

function parseTree(lines: readonly string[]): TreeNode | null {
  let root: TreeNode | null = null;
  const stack: { indent: number; node: TreeNode }[] = [];
  let count = 0;
  for (const line of lines) {
    if (count >= MAX_NODES) break;
    const prefix = /^[\s│├└─┬┼]*(?:[-*•]\s+)?/u.exec(line)![0];
    const node = makeNode(line.slice(prefix.length));
    if (!node) continue;
    count += 1;
    const indent = prefix.length;
    if (!root) {
      root = node;
      stack.push({ indent, node });
      continue;
    }
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.node;
    node.depth = parent.depth + 1;
    parent.children.push(node);
    stack.push({ indent: Math.max(indent, stack.at(-1)!.indent + 1), node });
  }
  return root;
}

function makeNode(text: string): TreeNode | null {
  const { text: rest, tags } = takeTags(text);
  const { head, detail } = splitDetail(rest);
  const label = cleanLabel(head);
  if (!label) return null;
  return { plate: measurePlate({ head: label, detail, tags }), children: [], depth: 0, y: 0 };
}

function drawTree(root: TreeNode, header: Header): string {
  if (root.plate.node.tags.names.size === 0) root.plate.node.tags.names.add("key");
  const columns: number[] = [];
  const visit = (node: TreeNode) => {
    columns[node.depth] = Math.max(columns[node.depth] ?? 0, node.plate.width);
    node.children.forEach(visit);
  };
  visit(root);
  const lefts = [0];
  for (let i = 1; i < columns.length; i += 1) {
    lefts.push(lefts[i - 1]! + columns[i - 1]! + COLUMN_GAP);
  }
  let cursor = 0;
  const place = (node: TreeNode) => {
    const start = cursor;
    node.children.forEach(place);
    if (node.children.length === 0) {
      node.y = cursor + node.plate.height / 2;
      cursor += node.plate.height + ROW_GAP;
      return;
    }
    node.y = (node.children[0]!.y + node.children.at(-1)!.y) / 2;
    if (cursor - start < node.plate.height + ROW_GAP) cursor = start + node.plate.height + ROW_GAP;
  };
  place(root);
  const bounds = new Bounds();
  const links: string[] = [];
  const plates: string[] = [];
  const draw = (node: TreeNode) => {
    const x = lefts[node.depth]!;
    bounds.add(x, node.y - node.plate.height / 2, node.plate.width, node.plate.height);
    plates.push(plateSvg(node.plate, x + node.plate.width / 2, node.y));
    for (const child of node.children) {
      const x1 = x + node.plate.width;
      const x2 = lefts[child.depth]!;
      const middle = (x1 + x2) / 2;
      links.push(
        `<path class="mc-edge" d="M${num(x1)} ${num(node.y)}C${num(middle)} ${num(node.y)} ${num(middle)} ${num(child.y)} ${num(x2)} ${num(child.y)}"/>`,
      );
      draw(child);
    }
  };
  draw(root);
  return svgDocument(links.join("") + plates.join(""), bounds, header.title || "Tree");
}
