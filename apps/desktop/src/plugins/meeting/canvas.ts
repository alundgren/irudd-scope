import type { Block, Canvas, CanvasOp, EditOp, Page, Section, SectionSize } from "./contract.ts";
import {
  BLOCK_KINDS,
  MAX_OPS,
  MAX_SECTION_BLOCKS,
  MAX_SECTIONS,
  MAX_SOURCE,
  SECTION_SIZES,
} from "./contract.ts";
import { applyOps, guessKind } from "./page.ts";

export type AppliedCanvasOps = {
  canvas: Canvas;
  /** Section ids added or changed, in op order. */
  changed: string[];
  /** Section ids created by these ops. */
  created: string[];
  rejected: { op: CanvasOp; reason: string }[];
};

/**
 * Says whether an op may touch a section, or one block in it when `blockId` is set.
 * The view uses it to keep model replies off what the person changed meanwhile.
 */
export type CanvasGuard = (sectionId: string, blockId: string | null) => string | null;

export const SECTION_WIDTH: Record<SectionSize, number> = { s: 480, m: 760, l: 1080 };
/** Unpinned sections wrap inside this width, so window and panel size never move them. */
export const FLOW_WIDTH = 3200;
export const FLOW_GAP = 48;
/** The id a section's first block gets from `create_section`. */
export const FIRST_BLOCK = "main";
/** Name-word overlap below this does not name a section. */
export const MIN_NAME_MATCH = 0.5;

const MAX_ID = 40;
const MAX_NAME = 80;
const MAX_TITLE = 160;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const NAME_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "and",
  "section",
  "diagram",
  "chart",
  "en",
  "ett",
  "den",
  "det",
  "för",
  "och",
  "av",
]);

export function emptyCanvas(): Canvas {
  return { version: 2, title: "Meeting", sections: [] };
}

/**
 * A page saved by the first test build, as one section named after its title. A page
 * with more blocks than a section holds continues in further sections.
 */
export function pageToCanvas(page: Page): Canvas {
  const title = page.title.trim().slice(0, MAX_TITLE) || "Meeting";
  const name = title.slice(0, MAX_NAME);
  const sections: Section[] = [];
  for (let start = 0; start < page.blocks.length; start += MAX_SECTION_BLOCKS) {
    if (sections.length >= MAX_SECTIONS) break;
    const part =
      sections.length === 0 ? name : `${name.slice(0, MAX_NAME - 4)} ${sections.length + 1}`;
    sections.push({
      id: uniqueId(sections, part),
      name: part,
      size: "l",
      pinned: false,
      x: 0,
      y: 0,
      blocks: page.blocks.slice(start, start + MAX_SECTION_BLOCKS),
    });
  }
  return { version: 2, title, sections };
}

/**
 * Applies ops in order. Never throws; bad ops are reported in `rejected`. An op with
 * `section: null` goes to the section created earlier in the same reply, otherwise to
 * `focus`.
 */
export function applyCanvasOps(
  canvas: Canvas,
  ops: readonly CanvasOp[],
  focus: string | null,
  guard?: CanvasGuard,
): AppliedCanvasOps {
  const draft: Draft = { sections: [...canvas.sections], created: null, focus };
  const changed: string[] = [];
  const created: string[] = [];
  const rejected: { op: CanvasOp; reason: string }[] = [];
  ops.forEach((op, index) => {
    const result =
      index >= MAX_OPS
        ? `Only ${MAX_OPS} ops are allowed per reply.`
        : applyOne(draft, op, guard ?? (() => null));
    if (typeof result === "string") return void rejected.push({ op, reason: result });
    if (result.changed) changed.push(result.changed);
    if (result.created) created.push(result.created);
  });
  const present = new Set(draft.sections.map((section) => section.id));
  return {
    canvas: { version: 2, title: canvas.title, sections: draft.sections },
    changed: changed.filter((id, index) => present.has(id) && changed.lastIndexOf(id) === index),
    created: created.filter((id) => present.has(id)),
    rejected,
  };
}

/** Exact id, then case-insensitive name, then name-word overlap of at least 0.5. */
export function findSection(canvas: Canvas, ref: string): Section | undefined {
  return canvas.sections[findSectionIndex(canvas.sections, ref)];
}

/** The section source the edit model reads, with every block. */
export function sectionSource(section: Section): string {
  const blocks = section.blocks.map(
    (block) =>
      `[block id=${block.id} kind=${block.kind} width=${block.width}]\n${block.source}\n[/block]`,
  );
  const head = `[section id=${section.id} size=${section.size} name=${JSON.stringify(section.name)}]`;
  return [head, ...(blocks.length ? blocks : ["(no blocks)"]), "[/section]"].join("\n");
}

/** Lowercase name words without filler such as "the" or "section". */
export function nameWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !NAME_STOP_WORDS.has(word),
  );
}

/** Jaccard overlap of two word lists. */
export function wordOverlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

type Draft = { sections: Section[]; created: string | null; focus: string | null };
/** A rejection reason, or the section the op created or changed. */
type OpResult = string | { changed: string | null; created?: string };

function applyOne(draft: Draft, op: CanvasOp, guard: CanvasGuard): OpResult {
  if (op.op === "create_section") return createSection(draft, op);
  const index = targetIndex(draft, op.section);
  if (typeof index === "string") return index;
  const section = draft.sections[index]!;
  switch (op.op) {
    case "rename_section": {
      const name = cleanName(op.name ?? op.text);
      if (!name) return "rename_section needs a name.";
      const blocked = guard(section.id, null);
      if (blocked) return blocked;
      draft.sections[index] = { ...section, name };
      return { changed: section.id };
    }
    case "resize_section": {
      const size = SECTION_SIZES.find((known) => known === op.size);
      if (!size) return "resize_section needs a size of s, m or l.";
      const blocked = guard(section.id, null);
      if (blocked) return blocked;
      draft.sections[index] = { ...section, size };
      return { changed: section.id };
    }
    case "remove_section": {
      const blocked = guard(section.id, null);
      if (blocked) return blocked;
      draft.sections.splice(index, 1);
      return { changed: null };
    }
    case "add":
    case "replace":
    case "patch":
    case "remove":
      return blockOp(draft, index, op, op.op, guard);
    default:
      return `Unknown op "${String((op as { op: unknown }).op)}".`;
  }
}

function createSection(draft: Draft, op: CanvasOp): OpResult {
  if (draft.sections.length >= MAX_SECTIONS)
    return `The canvas already has ${MAX_SECTIONS} sections.`;
  const name = cleanName(op.name ?? op.text);
  if (!name) return "create_section needs a name.";
  const size = op.size === null ? "m" : SECTION_SIZES.find((known) => known === op.size);
  if (!size) return `Unknown size "${String(op.size)}".`;
  const blocks: Block[] = [];
  if (op.source !== null && op.source.trim()) {
    if (op.source.length > MAX_SOURCE) return `Source is over ${MAX_SOURCE} characters.`;
    const kind = op.kind === null ? guessKind(op.source) : BLOCK_KINDS.find((k) => k === op.kind);
    if (!kind) return `Unknown kind "${String(op.kind)}".`;
    blocks.push({ id: FIRST_BLOCK, kind, width: op.width ?? "full", source: op.source });
  }
  const id = uniqueId(draft.sections, op.id && ID_PATTERN.test(op.id) ? op.id : name);
  draft.sections.push({ id, name, size, pinned: false, x: 0, y: 0, blocks });
  draft.created = id;
  return { changed: id, created: id };
}

function blockOp(
  draft: Draft,
  index: number,
  op: CanvasOp,
  kind: EditOp["op"] & CanvasOp["op"],
  guard: CanvasGuard,
): OpResult {
  const section = draft.sections[index]!;
  if (kind === "add" && section.blocks.length >= MAX_SECTION_BLOCKS)
    return `Section "${section.name}" already has ${MAX_SECTION_BLOCKS} blocks.`;
  // "Make that one vertical" often comes without a block id; a one-block section has one answer.
  const id =
    kind === "add" || op.id !== null
      ? op.id
      : section.blocks.length === 1
        ? section.blocks[0]!.id
        : section.blocks.some((block) => block.id === FIRST_BLOCK)
          ? FIRST_BLOCK
          : null;
  if (kind !== "add") {
    const blocked = guard(section.id, blockKey(section, id));
    if (blocked) return blocked;
  }
  const edit: EditOp = {
    op: kind,
    id,
    kind: op.kind,
    width: op.width,
    after: op.after,
    source: op.source,
    find: op.find,
    text: op.text,
  };
  const result = applyOps({ version: 1, title: "", blocks: section.blocks }, [edit]);
  const reason = result.rejected[0]?.reason;
  if (reason) return reason;
  draft.sections[index] = { ...section, blocks: result.page.blocks };
  return { changed: section.id };
}

/** The block id an op names, resolved the way page.ts finds blocks. */
function blockKey(section: Section, id: string | null): string | null {
  if (id === null) return null;
  const exact = section.blocks.find((block) => block.id === id);
  return exact ? exact.id : (section.blocks.find((block) => block.id === slugify(id))?.id ?? id);
}

function targetIndex(draft: Draft, ref: string | null): number | string {
  if (ref !== null && ref.trim()) {
    const index = findSectionIndex(draft.sections, ref);
    return index >= 0 ? index : `No section matches "${ref}".`;
  }
  const fallback = draft.created ?? draft.focus;
  const index = fallback === null ? -1 : draft.sections.findIndex((s) => s.id === fallback);
  return index >= 0 ? index : "The op names no section and no section is in focus.";
}

function findSectionIndex(sections: readonly Section[], ref: string): number {
  const wanted = ref.trim();
  if (!wanted) return -1;
  const exact = sections.findIndex((section) => section.id === wanted);
  if (exact >= 0) return exact;
  const slug = slugify(wanted);
  const bySlug = sections.findIndex((section) => section.id === slug);
  if (bySlug >= 0) return bySlug;
  const lower = wanted.replace(/\s+/g, " ").toLowerCase();
  const byName = sections.findIndex((section) => section.name.toLowerCase() === lower);
  if (byName >= 0) return byName;
  const words = nameWords(wanted);
  let best = -1;
  let bestScore = 0;
  sections.forEach((section, index) => {
    const score = wordOverlap(words, nameWords(section.name));
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return bestScore >= MIN_NAME_MATCH ? best : -1;
}

function cleanName(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
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
  return slug || "section";
}

function uniqueId(sections: readonly Section[], wanted: string): string {
  const base = ID_PATTERN.test(wanted) && wanted.length <= MAX_ID ? wanted : slugify(wanted);
  const taken = new Set(sections.map((section) => section.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ID - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
