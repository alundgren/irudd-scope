import type { Block, BlockKind, BlockWidth, EditOp, Page } from "./contract.ts";
import { splitSource } from "./diagram/header.ts";
import {
  BLOCK_KINDS,
  BLOCK_WIDTHS,
  DIAGRAM_KINDS,
  MAX_BLOCKS,
  MAX_OPS,
  MAX_SOURCE,
} from "./contract.ts";

export type AppliedOps = {
  page: Page;
  /** Ids of blocks added or changed, in op order, so the view can scroll to the latest. */
  changed: string[];
  rejected: { op: EditOp; reason: string }[];
};

const MAX_ID = 40;
const MAX_TITLE = 160;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function emptyPage(): Page {
  return { version: 1, title: "Meeting", blocks: [] };
}

/** Applies ops in order. A bad op is reported in `rejected` and never throws. */
export function applyOps(page: Page, ops: readonly EditOp[]): AppliedOps {
  const draft: Draft = { title: page.title, blocks: [...page.blocks] };
  const changed: string[] = [];
  const rejected: { op: EditOp; reason: string }[] = [];
  ops.forEach((op, index) => {
    const result =
      index >= MAX_OPS ? `Only ${MAX_OPS} ops are allowed per reply.` : applyOne(draft, op);
    if (typeof result === "string") rejected.push({ op, reason: result });
    else if (result.changed) changed.push(result.changed);
  });
  const present = new Set(draft.blocks.map((block) => block.id));
  const latest = changed.filter(
    (id, index) => present.has(id) && changed.lastIndexOf(id) === index,
  );
  return {
    page: { version: 1, title: draft.title, blocks: draft.blocks },
    changed: latest,
    rejected,
  };
}

/** The compact page text the edit model reads. */
export function pageSource(page: Page): string {
  const title = `title: ${page.title}`;
  if (page.blocks.length === 0) return `${title}\n(empty page)`;
  const blocks = page.blocks.map(
    (block) =>
      `[block id=${block.id} kind=${block.kind} width=${block.width}]\n${block.source}\n[/block]`,
  );
  return [title, ...blocks].join("\n\n");
}

type Draft = { title: string; blocks: Block[] };
/** A rejection reason, or the id the op added or changed. */
type OpResult = string | { changed: string | null };

function applyOne(draft: Draft, op: EditOp): OpResult {
  switch (op.op) {
    case "add":
      return addBlock(draft, op);
    case "replace":
      return replaceBlock(draft, op);
    case "patch":
      return patchBlock(draft, op);
    case "move":
      return moveBlock(draft, op);
    case "remove":
      return removeBlock(draft, op);
    case "title":
      return setTitle(draft, op);
    default:
      return `Unknown op "${String((op as { op: unknown }).op)}".`;
  }
}

function addBlock(draft: Draft, op: EditOp): OpResult {
  if (draft.blocks.length >= MAX_BLOCKS) return `The page already has ${MAX_BLOCKS} blocks.`;
  const kind = op.kind === null ? guessKind(op.source) : checkKind(op.kind);
  if (kind === null) return `Unknown kind "${String(op.kind)}".`;
  const width = op.width === null ? "full" : checkWidth(op.width);
  if (width === null) return `Unknown width "${String(op.width)}".`;
  if (op.source === null) return "add needs a source.";
  if (op.source.length > MAX_SOURCE) return `Source is over ${MAX_SOURCE} characters.`;
  const id = uniqueId(draft.blocks, op.id ?? kind);
  const position = insertIndex(draft.blocks, op.after);
  draft.blocks.splice(position, 0, { id, kind, width, source: op.source });
  return { changed: id };
}

function replaceBlock(draft: Draft, op: EditOp): OpResult {
  const index = findBlock(draft.blocks, op.id);
  if (index < 0) return missingBlock(op.id);
  if (op.source === null && op.kind === null && op.width === null) {
    return "replace needs a source, kind or width.";
  }
  const current = draft.blocks[index]!;
  const next = replacement(current, op);
  if (typeof next === "string") return next;
  draft.blocks[index] = next;
  return { changed: current.id };
}

/** The block with the op's non-null fields applied, or a rejection reason. */
function replacement(current: Block, op: EditOp): Block | string {
  const kind = op.kind === null ? current.kind : checkKind(op.kind);
  if (kind === null) return `Unknown kind "${String(op.kind)}".`;
  const width = op.width === null ? current.width : checkWidth(op.width);
  if (width === null) return `Unknown width "${String(op.width)}".`;
  const source = op.source ?? current.source;
  if (source.length > MAX_SOURCE) return `Source is over ${MAX_SOURCE} characters.`;
  return { id: current.id, kind, width, source };
}

function patchBlock(draft: Draft, op: EditOp): OpResult {
  const index = findBlock(draft.blocks, op.id);
  if (index < 0) return missingBlock(op.id);
  if (!op.find) return "patch needs a non-empty find.";
  if (op.text === null) return "patch needs a text.";
  const current = draft.blocks[index]!;
  const at = current.source.indexOf(op.find);
  if (at < 0) return `The find text is not in block "${current.id}".`;
  const source = current.source.slice(0, at) + op.text + current.source.slice(at + op.find.length);
  if (source.length > MAX_SOURCE) return `Source is over ${MAX_SOURCE} characters.`;
  draft.blocks[index] = { ...current, source };
  return { changed: current.id };
}

function moveBlock(draft: Draft, op: EditOp): OpResult {
  const index = findBlock(draft.blocks, op.id);
  if (index < 0) return missingBlock(op.id);
  const [block] = draft.blocks.splice(index, 1);
  if (op.after !== null && op.after !== "start" && findBlock(draft.blocks, op.after) < 0) {
    draft.blocks.splice(index, 0, block!);
    return `move after "${op.after}" names no other block.`;
  }
  draft.blocks.splice(insertIndex(draft.blocks, op.after), 0, block!);
  return { changed: block!.id };
}

function removeBlock(draft: Draft, op: EditOp): OpResult {
  const index = findBlock(draft.blocks, op.id);
  if (index < 0) return missingBlock(op.id);
  draft.blocks.splice(index, 1);
  return { changed: null };
}

function setTitle(draft: Draft, op: EditOp): OpResult {
  const title = (op.text ?? "").replace(/\s+/g, " ").trim();
  if (!title) return "title needs a non-empty text.";
  if (title.length > MAX_TITLE) return `Title is over ${MAX_TITLE} characters.`;
  draft.title = title;
  return { changed: null };
}

// Fast models sometimes leave out the kind of a new block; its first line usually tells.
const FLOW_DIRECTION = /^(right|down|lr|td|tb|vertical)$/i;

function guessKind(source: string | null): BlockKind {
  const header = splitSource(source ?? "")?.header;
  if (!header || !DIAGRAM_KINDS.some((kind) => kind === header.kind)) return "text";
  // "Compare options" is prose; only flow takes an argument, and only a direction.
  return header.arg === "" || (header.kind === "flow" && FLOW_DIRECTION.test(header.arg))
    ? "diagram"
    : "text";
}

function checkKind(kind: unknown): BlockKind | null {
  return BLOCK_KINDS.find((known) => known === kind) ?? null;
}
function checkWidth(width: unknown): BlockWidth | null {
  return BLOCK_WIDTHS.find((known) => known === width) ?? null;
}

function missingBlock(id: string | null): string {
  return id === null ? "The op needs an id." : `No block has id "${id}".`;
}

/** Exact id first, then the slug, so `Login Flow` still finds `login-flow`. */
function findBlock(blocks: readonly Block[], id: string | null): number {
  if (id === null) return -1;
  const exact = blocks.findIndex((block) => block.id === id);
  if (exact >= 0) return exact;
  const slug = slugify(id);
  return blocks.findIndex((block) => block.id === slug);
}

function insertIndex(blocks: readonly Block[], after: string | null): number {
  if (after === "start") return 0;
  const index = findBlock(blocks, after);
  return index < 0 ? blocks.length : index + 1;
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_ID)
    .replace(/-+$/, "");
  return slug || "block";
}

function uniqueId(blocks: readonly Block[], wanted: string): string {
  const base = ID_PATTERN.test(wanted) && wanted.length <= MAX_ID ? wanted : slugify(wanted);
  // "start" is reserved because `after: "start"` means the top of the page.
  const taken = new Set(["start", ...blocks.map((block) => block.id)]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ID - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
