import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gitDiff(before: string, after: string): string {
  if (before === after) return "";
  const directory = mkdtempSync(join(tmpdir(), "scope-plan-diff-"));
  try {
    writeFileSync(join(directory, "before.html"), before);
    writeFileSync(join(directory, "after.html"), after);
    const result = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--text",
        "--",
        "before.html",
        "after.html",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 1) throw new Error(`Git diff failed: ${result.stderr}`);
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function changedRange(base: string, value: string) {
  let start = 0;
  while (start < base.length && start < value.length && base[start] === value[start]) start++;
  let end = base.length;
  let valueEnd = value.length;
  while (end > start && valueEnd > start && base[end - 1] === value[valueEnd - 1]) {
    end--;
    valueEnd--;
  }
  return { start, end, text: value.slice(start, valueEnd) };
}
export function rebaseHtml(base: string, current: string, proposal: string): string | null {
  if (current === base) return proposal;
  if (proposal === base) return current;
  const accepted = changedRange(base, current);
  const incoming = changedRange(base, proposal);
  // Touching edits are rejected too: inserting at a deleted range's boundary can change meaning.
  if (incoming.end < accepted.start)
    return current.slice(0, incoming.start) + incoming.text + current.slice(incoming.end);
  if (accepted.end < incoming.start) {
    const offset = accepted.text.length - (accepted.end - accepted.start);
    return (
      current.slice(0, incoming.start + offset) +
      incoming.text +
      current.slice(incoming.end + offset)
    );
  }
  return null;
}
