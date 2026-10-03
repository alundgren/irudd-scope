export type DiffLine = {
  kind: "context" | "added" | "removed" | "hunk" | "meta";
  text: string;
  before?: number;
  after?: number;
};
export type DiffFile = { path: string; previousPath?: string; lines: DiffLine[] };

function gitPath(value: string) {
  if (!value.startsWith('"')) return value;
  const escaped = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] !== "\\") {
      const character = String.fromCodePoint(escaped.codePointAt(index)!);
      bytes.push(...new TextEncoder().encode(character));
      index += character.length - 1;
      continue;
    }
    const octal = escaped.slice(index + 1).match(/^[0-7]{3}/)?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      index += 3;
    } else {
      const character = escaped[++index] ?? "";
      bytes.push(
        ...new TextEncoder().encode({ t: "\t", n: "\n", r: "\r" }[character] ?? character),
      );
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let before = 0,
    after = 0,
    inHunk = false;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("diff --git ")) {
      const paths = text.slice(11).match(/^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/);
      file = { path: paths ? gitPath(paths[2]!).slice(2) : text.slice(11), lines: [] };
      if (paths) file.previousPath = gitPath(paths[1]!).slice(2);
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "hunk", text });
    } else if (inHunk && text.startsWith("+")) {
      file.lines.push({ kind: "added", text: text.slice(1), after: after++ });
    } else if (inHunk && text.startsWith("-")) {
      file.lines.push({ kind: "removed", text: text.slice(1), before: before++ });
    } else if (inHunk && text.startsWith(" ")) {
      file.lines.push({ kind: "context", text: text.slice(1), before: before++, after: after++ });
    } else if (!inHunk && text.startsWith("+++ ")) {
      const path = gitPath(text.slice(4));
      if (path !== "/dev/null") file.path = path.slice(2);
    } else if (!inHunk && text.startsWith("--- ")) {
      const path = gitPath(text.slice(4));
      if (path !== "/dev/null") file.previousPath = path.slice(2);
    } else if (text.startsWith("rename to ")) {
      file.path = gitPath(text.slice(10));
    } else if (text.startsWith("rename from ")) {
      file.previousPath = gitPath(text.slice(12));
    } else if (!text.startsWith("index ")) {
      file.lines.push({ kind: "meta", text });
    }
  }
  return files;
}

export function splitDiff(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const result: { left?: DiffLine; right?: DiffLine }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind !== "removed" && line.kind !== "added") {
      result.push({ left: line, right: line });
      continue;
    }
    const removed: DiffLine[] = [],
      added: DiffLine[] = [];
    while (index < lines.length && ["removed", "added"].includes(lines[index]!.kind)) {
      const change = lines[index++]!;
      (change.kind === "removed" ? removed : added).push(change);
    }
    index--;
    for (let row = 0; row < Math.max(removed.length, added.length); row++)
      result.push({ left: removed[row], right: added[row] });
  }
  return result;
}
