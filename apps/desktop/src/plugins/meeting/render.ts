import katex from "katex";
import type { TokenizerAndRendererExtension, Tokens } from "marked";
import { Marked } from "marked";
import type { Block, BlockKind, BlockWidth, Canvas, Section } from "./contract.ts";
import { BLOCK_KINDS, BLOCK_WIDTHS, SECTION_SIZES } from "./contract.ts";
import { FLOW_WIDTH } from "./canvas.ts";
import { renderDiagram } from "./diagram/index.ts";
import { escapeHtml } from "./html.ts";

const CALLOUT_LABELS: Partial<Record<BlockKind, string>> = {
  note: "Note",
  decision: "Decision",
  risk: "Risk",
  question: "Question",
};

/**
 * HTML for one block. `key` becomes `data-block`; the canvas uses `sectionId/blockId`.
 * Model text is escaped; callers still sanitize before use.
 */
export function renderBlock(block: Block, key = block.id): string {
  const kind = BLOCK_KINDS.find((known) => known === block.kind) ?? "text";
  const width: BlockWidth = BLOCK_WIDTHS.find((known) => known === block.width) ?? "full";
  return (
    `<section class="mc-block mc-w-${width} mc-k-${kind}" data-block="${escapeHtml(key)}">` +
    blockBody(kind, block.source) +
    "</section>"
  );
}

/**
 * One section frame: the name label and its blocks. Pinned sections carry their canvas
 * position; unpinned ones take their place in the flow.
 */
export function renderSection(section: Section): string {
  const size = SECTION_SIZES.find((known) => known === section.size) ?? "m";
  const id = escapeHtml(section.id);
  const name = escapeHtml(section.name);
  const place = section.pinned
    ? ` style="left:${Math.round(section.x)}px;top:${Math.round(section.y)}px"`
    : "";
  const blocks = section.blocks.length
    ? section.blocks.map((block) => renderBlock(block, `${section.id}/${block.id}`)).join("")
    : '<p class="mc-section-empty">Empty section</p>';
  return (
    `<section class="mc-section mc-size-${size}${section.pinned ? " is-pinned" : ""}" data-section="${id}" aria-label="${name}"${place}>` +
    `<h2 class="mc-section-name" data-section-handle="${id}">${name}</h2>` +
    `<div class="mc-section-body"><div class="mc-grid">${blocks}</div></div></section>`
  );
}

/**
 * The whole canvas at 1:1. Unpinned sections wrap in creation order inside a fixed
 * 3200 px flow; pinned sections sit on a layer above it at their saved positions.
 */
export function renderCanvas(canvas: Canvas): string {
  const flow = canvas.sections.filter((section) => !section.pinned).map(renderSection);
  const pinned = canvas.sections.filter((section) => section.pinned).map(renderSection);
  return (
    `<div class="mc-canvas-inner"><h1 class="mc-title">${escapeHtml(canvas.title)}</h1>` +
    `<div class="mc-flow" style="width:${FLOW_WIDTH}px">${flow.join("")}</div>` +
    `<div class="mc-pinned">${pinned.join("")}</div></div>`
  );
}

function blockBody(kind: BlockKind, source: string): string {
  if (kind === "diagram") return renderDiagram(source);
  const markdown = `<div class="mc-md">${renderMarkdown(source)}</div>`;
  const label = CALLOUT_LABELS[kind];
  return label ? `<div class="mc-eyebrow mc-callout-label">${label}</div>${markdown}` : markdown;
}

/** Markdown to HTML. Raw HTML is shown as text, only web and mail links survive, images become their alt text. */
export function renderMarkdown(source: string): string {
  try {
    return markdown.parse(source, { async: false });
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

/** The link target, or null for anything but web and mail links. Leading spaces or controls fail the test. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!SAFE_URL.test(trimmed)) return null;
  try {
    return encodeURI(decodeURI(trimmed));
  } catch {
    return encodeURI(trimmed);
  }
}

function renderMath(tex: string, displayMode: boolean): string {
  try {
    // The annotation repeats the TeX source; DOMPurify drops the element but keeps its text.
    return katex
      .renderToString(tex, {
        displayMode,
        output: "mathml",
        trust: false,
        throwOnError: false,
        maxSize: 20,
        maxExpand: 500,
        strict: "ignore",
      })
      .replace(/<annotation[^>]*>[^<]*<\/annotation>/g, "");
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => {
    const index = src.indexOf("$$");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
    if (!match) return undefined;
    return { type: "mathBlock", raw: match[0], text: match[1]!.trim() };
  },
  renderer: (token) => `<div class="mc-math">${renderMath(String(token.text), true)}</div>\n`,
};

const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => {
    const index = src.indexOf("$");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const display = /^\$\$([^$]+?)\$\$/.exec(src);
    if (display) return { type: "mathInline", raw: display[0], text: display[1]!, display: true };
    // `$5 and $10` stays text: no space inside the delimiters and no digit after the close.
    const inline = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (inline) return { type: "mathInline", raw: inline[0], text: inline[1]!, display: false };
    return undefined;
  },
  renderer: (token) => renderMath(String(token.text), token.display === true),
};

const markdown = new Marked({ gfm: true, breaks: false });
markdown.use({
  extensions: [mathBlock, mathInline],
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      const escaped = escapeHtml(token.text);
      return token.block ? `<p>${escaped}</p>\n` : escaped;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (safe === null) return inner;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr} rel="noopener noreferrer" target="_blank">${inner}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});
