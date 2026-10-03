import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { Actor } from "../../src/contracts.ts";

export type EditOperation =
  | { kind: "replace-text"; nodeId: string; expectedText: string; text: string }
  | { kind: "insert-after"; nodeId: string; html: string }
  | { kind: "delete-node"; nodeId: string; expectedHtml: string };
export type Operation =
  | EditOperation
  | { kind: "resolve"; conflictId: string; text: string }
  | { kind: "restore"; revision: number }
  | { kind: "merge"; revisions: number[] };
export type Change = {
  id: string;
  revision: number;
  branch: string;
  parentRevision: number;
  parents: number[];
  actor: Actor;
  reason: string;
  operation: Operation;
  reducerVersion: 1;
  createdAt: number;
};
export type Conflict = {
  id: string;
  nodeId: string;
  proposal: string;
  competingChanges: string[];
  reason: string;
  operation: EditOperation;
  actual: string | null;
  status: "unresolved" | "resolved";
  resolution?: { changeId: string; actor: Actor; text: string };
};
export type State = {
  html: string;
  provenance: Record<string, string>;
  conflicts: Record<string, Conflict>;
};
type Element = DefaultTreeAdapterMap["element"];
export const initialState = (html: string): State => ({ html, provenance: {}, conflicts: {} });

function elements(html: string, fragment = false) {
  const result: Element[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) result.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };
  visit(
    fragment
      ? parseFragment(html, { sourceCodeLocationInfo: true })
      : parse(html, { sourceCodeLocationInfo: true }),
  );
  return result;
}
const idOf = (node: Element) => node.attrs.find((attribute) => attribute.name === "id")?.value;
function target(html: string, id: string) {
  const matches = elements(html).filter((node) => idOf(node) === id);
  return matches.length === 1 && matches[0].sourceCodeLocation ? matches[0] : null;
}
function plainText(node: Element) {
  if (
    [
      "script",
      "style",
      "textarea",
      "title",
      "xmp",
      "iframe",
      "noembed",
      "noframes",
      "plaintext",
      "noscript",
    ].includes(node.tagName)
  )
    return null;
  if (node.childNodes.some((child) => child.nodeName !== "#text")) return null;
  return node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
}
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
function patch(html: string, start: number, end: number, replacement: string) {
  return html.slice(0, start) + replacement + html.slice(end);
}

function conflict(
  state: State,
  change: Change,
  operation: EditOperation,
  reason: string,
  actual: string | null,
) {
  const id = `conflict-${change.id}`;
  const previous = Object.hasOwn(state.provenance, operation.nodeId)
    ? state.provenance[operation.nodeId]
    : undefined;
  state.conflicts[id] = {
    id,
    nodeId: operation.nodeId,
    proposal: change.id,
    competingChanges: previous ? [previous, change.id] : [change.id],
    reason,
    operation,
    actual,
    status: "unresolved",
  };
}

// The experiment deliberately patches authored bytes, rather than serializing a parsed DOM.
export function applyEdit(input: State, change: Change, operation: EditOperation): State {
  const state = structuredClone(input);
  const node = target(state.html, operation.nodeId);
  if (!node) {
    conflict(state, change, operation, "Target is missing or its authored ID is ambiguous.", null);
    return state;
  }
  const location = node.sourceCodeLocation!;
  if (operation.kind === "replace-text") {
    const actual = plainText(node);
    if (actual === null || !location.startTag || !location.endTag) {
      conflict(state, change, operation, "Target is not an ordinary authored text block.", actual);
      return state;
    }
    if (actual !== operation.expectedText) {
      conflict(state, change, operation, "Another change replaced the expected value.", actual);
      return state;
    }
    state.html = patch(
      state.html,
      location.startTag.endOffset,
      location.endTag.startOffset,
      escaped(operation.text),
    );
  } else if (operation.kind === "delete-node") {
    const actual = state.html.slice(location.startOffset, location.endOffset);
    if (actual !== operation.expectedHtml) {
      conflict(
        state,
        change,
        operation,
        "Another change modified the node before deletion.",
        actual,
      );
      return state;
    }
    state.html = patch(state.html, location.startOffset, location.endOffset, "");
  } else {
    const inserted = elements(operation.html, true);
    const ids = inserted.map(idOf).filter((id): id is string => id !== undefined);
    const existing = new Set(elements(state.html).map(idOf).filter(Boolean));
    if (
      !inserted.length ||
      ids.length !== new Set(ids).size ||
      ids.some((id) => !id || existing.has(id))
    ) {
      conflict(
        state,
        change,
        operation,
        "Inserted markup has no element or has a duplicate authored ID.",
        null,
      );
      return state;
    }
    state.html = patch(state.html, location.endOffset, location.endOffset, operation.html);
    for (const id of ids) state.provenance = { ...state.provenance, [id]: change.id };
  }
  if (operation.kind !== "insert-after")
    state.provenance = { ...state.provenance, [operation.nodeId]: change.id };
  return state;
}

export function applyResolution(
  input: State,
  change: Change,
  operation: Extract<Operation, { kind: "resolve" }>,
  parent: State = input,
): State {
  const pending = input.conflicts[operation.conflictId];
  const original = parent.conflicts[operation.conflictId];
  if (!pending || !original || pending.status !== "unresolved" || original.status !== "unresolved")
    throw new Error("Conflict is not unresolved.");
  if (pending.operation.kind !== "replace-text")
    throw new Error("Only text-choice conflicts support resolution in this experiment.");
  const node = target(input.html, pending.nodeId);
  const text = node ? plainText(node) : null;
  if (text === null || !node?.sourceCodeLocation?.startTag || !node.sourceCodeLocation.endTag)
    throw new Error("Conflict target is no longer an ordinary authored text block.");
  const originalNode = target(parent.html, original.nodeId);
  const expected = originalNode ? plainText(originalNode) : null;
  if (pending.nodeId !== original.nodeId || text !== expected)
    throw new Error("Conflict target changed after the parent revision.");
  const state = applyEdit(input, change, {
    kind: "replace-text",
    nodeId: pending.nodeId,
    expectedText: text,
    text: operation.text,
  });
  state.conflicts[operation.conflictId] = {
    ...pending,
    status: "resolved",
    resolution: { changeId: change.id, actor: change.actor, text: operation.text },
  };
  return state;
}
