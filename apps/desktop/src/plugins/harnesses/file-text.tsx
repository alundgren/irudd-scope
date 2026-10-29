import { useEffect, useState } from "react";
import type { HarnessFileOwner, HarnessFileReply } from "@irudd-scope/protocol/harnesses";
import { operationError } from "../../renderer/operation-error.ts";

/** Copies an allowed file's text; `name` names it in the confirmation. */
export type CopyFile = (file: HarnessFileReply, name: string) => void;

export type FileText =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; reply: HarnessFileReply };

/**
 * Reads one allowed file through the desktop; a newer request replaces an older answer.
 * `version` changes when a rescan may have found new text, which reads the file again.
 */
export function useHarnessFile(harness: HarnessFileOwner, path: string, version: string): FileText {
  const [text, setText] = useState<{ file: string; version: string; text: FileText }>();
  const file = `${harness}\n${path}`;
  useEffect(() => {
    let current = true;
    window.scope.harnessFile({ machine: "local", harness, path }).then(
      (reply) => current && setText({ file, version, text: { state: "loaded", reply } }),
      (error: unknown) =>
        current &&
        setText({
          file,
          version,
          text: { state: "failed", message: operationError(error, "Could not read the file.") },
        }),
    );
    return () => {
      current = false;
    };
  }, [file, version, harness, path]);
  // While a rescan's read runs, the text already shown stays instead of Reading….
  if (text?.file === file && (text.version === version || text.text.state === "loaded"))
    return text.text;
  return { state: "loading" };
}

export type Frontmatter = { name: string | null; description: string | null; body: string };

/**
 * Splits YAML frontmatter from Markdown and keeps only `name` and `description`, which skills
 * use as their title and summary. Folded and literal block values become one line. Other keys
 * are not shown. Text without frontmatter is all body.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const lines = text.split(/\r?\n/);
  const end =
    lines[0] === "---" ? lines.findIndex((line, index) => index > 0 && line === "---") : -1;
  if (end < 0) return { name: null, description: null, body: text };
  const header = lines.slice(1, end);
  return {
    name: frontmatterValue(header, "name"),
    description: frontmatterValue(header, "description"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function frontmatterValue(lines: string[], key: string): string | null {
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return null;
  const value = lines[index]!.slice(key.length + 1).trim();
  if (value && !/^[>|][+-]?$/.test(value)) return unquote(value) || null;
  // A block value continues on the indented lines that follow.
  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    if (line.trim()) block.push(line.trim());
  }
  return block.join(" ") || null;
}

function unquote(value: string) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1)
    return value.slice(1, -1);
  return value;
}
