import { escapeHtml } from "../html.ts";
import { renderBars } from "./bars.ts";
import { renderBoard } from "./board.ts";
import { renderEr } from "./er.ts";
import { renderFlow } from "./flow.ts";
import { DIAGRAM_KINDS } from "../contract.ts";
import type { DiagramKind, Header } from "./header.ts";
import { splitSource } from "./header.ts";
import {
  renderChecklist,
  renderCompare,
  renderMetrics,
  renderSteps,
  renderTimeline,
} from "./lists.ts";
import { renderSequence } from "./sequence.ts";
import { renderState } from "./state.ts";
import { renderTree } from "./tree.ts";
import { renderWireframe } from "./wireframe.ts";

type KindRenderer = (header: Header, body: readonly string[]) => string | null;

const RENDERERS: Record<DiagramKind, KindRenderer> = {
  flow: renderFlow,
  sequence: renderSequence,
  tree: renderTree,
  steps: (_header, body) => renderSteps(body),
  timeline: (_header, body) => renderTimeline(body),
  checklist: (_header, body) => renderChecklist(body),
  compare: (_header, body) => renderCompare(body),
  metrics: (_header, body) => renderMetrics(body),
  wireframe: renderWireframe,
  state: renderState,
  er: renderEr,
  board: (_header, body) => renderBoard(body),
  bars: renderBars,
};

/**
 * HTML for a diagram source. Unknown kinds, empty diagrams and renderer failures
 * become an error card with the escaped source; this never throws.
 */
export function renderDiagram(source: string): string {
  const parsed = splitSource(source);
  if (!parsed) return errorCard("The diagram is empty.", source);
  const { header, body } = parsed;
  const kind = DIAGRAM_KINDS.find((known) => known === header.kind);
  if (!kind) {
    return errorCard(
      `Unknown diagram kind "${header.kind}". Use one of: ${DIAGRAM_KINDS.join(", ")}.`,
      source,
    );
  }
  const render = RENDERERS[kind];
  let html: string | null;
  try {
    html = render(header, body);
  } catch (error) {
    return errorCard(`The ${header.kind} diagram could not be drawn: ${String(error)}`, source);
  }
  if (html === null) return errorCard(`The ${header.kind} diagram has nothing to draw.`, source);
  const title = header.title
    ? `<figcaption class="mc-d-title">${escapeHtml(header.title)}</figcaption>`
    : "";
  return `<figure class="mc-diagram mc-d-${header.kind}">${title}${html}</figure>`;
}

function errorCard(reason: string, source: string): string {
  return `<div class="mc-error" role="note"><div class="mc-error-head">${escapeHtml(reason)}</div><pre class="mc-error-source">${escapeHtml(source)}</pre></div>`;
}
