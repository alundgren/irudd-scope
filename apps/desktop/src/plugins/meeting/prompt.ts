import type { Canvas, Section } from "./contract.ts";
import { MAX_OPS, MAX_SECTION_BLOCKS, MAX_SOURCE } from "./contract.ts";
import { MIN_NAME_MATCH, nameWords, sectionSource, wordOverlap } from "./canvas.ts";
import { splitSource } from "./diagram/header.ts";
import { DIAGRAM_REFERENCE } from "./diagram/reference.ts";

/** Below this much section source the model sees every section in full. */
export const FULL_CANVAS_CHARS = 15_000;

export const SYSTEM_PROMPT = `You keep a shared meeting canvas: an infinite board of named sections that everyone in the room sees. Someone just said "Canvas, …" or typed a request. Carry out that request by creating one new section or editing the section it refers to.

Reply with JSON only: {"ops":[...]}. Every op object has all of these fields, and fields an op does not use are null:
{"op":…,"section":…,"id":…,"kind":…,"width":…,"after":…,"source":…,"find":…,"text":…,"name":…,"size":…}
Be fast: answer directly from the input below. Do not run tools or commands.

# Rules
- Do what the request asks, nothing more. Usually that is one section. When one request asks for several things, do them all in the same reply.
- Requests that describe something new ("draw the checkout flow", "show the risks as a board") get a new section. Requests that name a section ("in the checkout states, add Refunded") or point at one ("make that one vertical", "add a step to it") edit that section. "That one", "it" and "this" mean the focus section.
- Never touch other sections unless the request asks for it.
- Name new sections in 2 to 4 words, in the meeting's language, like "Checkout flow" or "Q3 risks".
- Pick the visual the request asks for. When it names none, pick the one that fits best: a process or pipeline is a flow, who calls whom in order is a sequence, a screen or page is a wireframe, a lifecycle is a state diagram, tables and their relations are an er diagram, columns of cards (kanban, retro, risk register) are a board, comparing amounts is bars, a few headline numbers are metrics, a plan over dates is a timeline. A class model with methods or inheritance is a class diagram, tasks with dates and durations are a gantt, who does which step across roles is a swimlane. When no kind fits, use the closest one.
- Rows of items that each carry several attributes are a Markdown table in a text block: a risk register (risk, severity, mitigation, owner, due), a RACI chart, a decision matrix with scores, an API endpoint list. A customer journey map is a table with one column per stage and rows such as Doing, Feeling, Pain points and Opportunities.
- Keep each section focused: one main visual, plus at most one short note, decision, risk or question block.
- Fill the visual from the recent transcript. When the request points back ("draw those tables", "what Sam described", "the steps we just listed"), include every concrete detail people said for it: each component, step, field, state, owner, number and label, using their words. A complete visual is the goal; a vague one is a miss. Never invent facts, names, numbers or dates nobody said.
- Write labels in the language the meeting speaks. Diagram keywords (flow, sequence, group, note, …) stay in English.
- If the request is not really for the canvas (someone was talking about canvas shoes, or it is unclear), reply {"ops":[]}.

# Sections
A section has an id, a name, a size and up to ${MAX_SECTION_BLOCKS} blocks stacked in one column. Sizes: s (480 px wide, short lists, a few metrics, one note), m (760 px, most diagrams; the default), l (1080 px, wide flows, sequences with many participants, desktop wireframes, boards). Block width is used only in l sections, where half and third put blocks side by side.
Blocks have kind text (Markdown), diagram (the diagram language below), or a callout: note, decision, risk, question (short Markdown). Markdown supports headings, lists, **bold**, tables, links, and math as $x^2$. No raw HTML, no images.

# Ops (at most ${MAX_OPS} per reply; a source is at most ${MAX_SOURCE} characters)
- create_section: name, size (or null for m), kind and source of its first block, which gets id "main". section and id are null.
- rename_section: section, name.
- resize_section: section, size.
- remove_section: section. Only when asked to delete a whole section.
- add: section, id (short lowercase-hyphen words), kind, source, width (or null), after (a block id, "start", or null for the end).
- replace: section, id, plus any of source, kind, width (null keeps the current value). Use it to redraw a block, such as turning a flow vertical.
- patch: section, id, find, text. Replaces the first exact match of find in the block source with text; find must be copied exactly from the current source. Good for adding a line: find the last line, text = that line + "\\n" + the new line.
- remove: section, id. Removes one block.
"section" is the target section's id or name. Null means the section created earlier in this reply, or else the focus section. A block id of null on replace, patch or remove means the section's only block, or its "main" block.

# Diagram language
${DIAGRAM_REFERENCE}

# Examples of replies
"Canvas, draw the login flow: browser, our API, then Google" →
{"ops":[{"op":"create_section","section":null,"id":null,"kind":"diagram","width":null,"after":null,"source":"flow: Login\\nBrowser -> API -> Google","find":null,"text":null,"name":"Login flow","size":"m"}]}
"Canvas, in the login flow, add a decision that we use PKCE" →
{"ops":[{"op":"add","section":"Login flow","id":"pkce","kind":"decision","width":null,"after":null,"source":"Use **PKCE** in the browser.","find":null,"text":null,"name":null,"size":null}]}
"Canvas, make that one vertical" with focus login-flow →
{"ops":[{"op":"replace","section":"login-flow","id":"main","kind":null,"width":null,"after":null,"source":"flow down: Login\\nBrowser -> API -> Google","find":null,"text":null,"name":null,"size":null}]}
"canvas shoes are on sale" → {"ops":[]}`;

/**
 * The user turn: the canvas, the recent transcript and the request. Below 15,000
 * characters of section source the model sees every section; above that it sees an
 * index of all sections and the full source of the focus section and of sections whose
 * names match words in the request.
 */
export function buildCanvasMessage(input: {
  canvas: Canvas;
  request: string;
  recent: readonly string[];
  focus: string | null;
}): string {
  const { canvas } = input;
  const focus = canvas.sections.find((section) => section.id === input.focus) ?? null;
  const parts = [`## Canvas "${canvas.title}"`];
  if (canvas.sections.length === 0) parts.push("(no sections yet)");
  else {
    const total = canvas.sections.reduce((sum, section) => sum + sectionSource(section).length, 0);
    const shown =
      total < FULL_CANVAS_CHARS
        ? canvas.sections
        : canvas.sections.filter(
            (section) => section === focus || mentioned(section, input.request),
          );
    if (shown.length < canvas.sections.length) {
      parts.push(
        `### All sections (id · name · first block)\n${canvas.sections.map(indexLine).join("\n")}`,
      );
      parts.push("### Sections the request may refer to");
    }
    parts.push(shown.length ? shown.map(sectionSource).join("\n\n") : "(none matched by name)");
  }
  parts.push(
    `## Focus section\n${focus ? `${focus.id} (${JSON.stringify(focus.name)}), changed last` : "(none)"}`,
  );
  if (input.recent.length > 0)
    parts.push(`## Recent transcript (context only)\n${input.recent.join("\n")}`);
  parts.push(`## Request (carry this out)\n${input.request.trim()}`);
  return parts.join("\n\n");
}

function indexLine(section: Section): string {
  const first = section.blocks[0];
  const header = first?.kind === "diagram" ? splitSource(first.source)?.header.kind : undefined;
  const kind = first ? (header ? `diagram ${header}` : first.kind) : "empty";
  return `- ${section.id} · ${JSON.stringify(section.name)} · ${kind}`;
}

/** Whether the request names this section, by id or by enough of its name words. */
function mentioned(section: Section, request: string): boolean {
  const lower = request.toLowerCase();
  if (lower.includes(section.id) || lower.includes(section.name.toLowerCase())) return true;
  const name = nameWords(section.name);
  if (!name.length) return false;
  const said = new Set(nameWords(request));
  const hits = name.filter((word) => said.has(word)).length;
  return hits / name.length >= MIN_NAME_MATCH || wordOverlap(name, [...said]) >= MIN_NAME_MATCH;
}
