import type { DIAGRAM_KINDS } from "../contract.ts";

export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export type Header = { kind: string; arg: string; title: string };

/**
 * Splits a diagram source into its header (`kind [arg] [: Title]`) and body lines.
 * Body lines keep their indentation, for `tree`; blank and `//` or `%%` comment
 * lines are dropped.
 */
export function splitSource(source: string): { header: Header; body: string[] } | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return null;
  const match = /^\s*([A-Za-z]+)\s*([^:]*?)\s*(?::\s*(.*?))?\s*$/.exec(lines[first]!);
  if (!match) return null;
  const header = { kind: match[1]!.toLowerCase(), arg: match[2]!, title: match[3] ?? "" };
  const body = lines
    .slice(first + 1)
    .map((line) => line.replace(/\t/g, "  ").trimEnd())
    .map((line) => line.replace(/→/g, "->"))
    // Mermaid habits fast models fall into: stray headers and brace-only lines.
    .filter((line) => !/^\s*(stateDiagram(-v2)?|erDiagram|[{}])\s*$/.test(line))
    .filter((line) => line.trim() !== "" && !/^\s*(\/\/|%%)/.test(line));
  return { header, body };
}
