import { diffChars } from "diff";

type Edit = { start: number; end: number; text: string };

function edits(base: string, text: string): Edit[] | null {
  let start = 0;
  while (start < base.length && start < text.length && base[start] === text[start]) start++;
  // Keep the changed region on code-point boundaries before jsdiff tokenizes it.
  if (
    start > 0 &&
    /[\uD800-\uDBFF]/.test(base[start - 1]) &&
    /[\uDC00-\uDFFF]/.test(base[start] ?? "")
  )
    start--;
  let end = base.length;
  let textEnd = text.length;
  while (end > start && textEnd > start && base[end - 1] === text[textEnd - 1]) {
    end--;
    textEnd--;
  }
  if (
    end < base.length &&
    /[\uD800-\uDBFF]/.test(base[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(base[end])
  ) {
    end++;
    textEnd++;
  }
  if (start === end || start === textEnd) return [{ start, end, text: text.slice(start, textEnd) }];
  const changes = diffChars(base.slice(start, end), text.slice(start, textEnd), {
    timeout: 100,
    maxEditLength: 10_000,
  });
  if (!changes) return null;
  const result: Edit[] = [];
  let offset = start;
  let current: Edit | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (current) result.push(current);
      current = null;
      offset += change.value.length;
      continue;
    }
    current ??= { start: offset, end: offset, text: "" };
    if (change.removed) {
      offset += change.value.length;
      current.end = offset;
    } else current.text += change.value;
  }
  if (current) result.push(current);
  return result;
}

// Preserve separate remote changes across snapshot jumps; overlap or exhausted search needs review.
export function mergeHtml(base: string, local: string, remote: string): string | null {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  const a = edits(base, local);
  const b = edits(base, remote);
  if (!a || !b) return null;
  const merged: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left.start === right.start && left.end === right.end && left.text === right.text) {
      merged.push(left);
      i++;
      j++;
    } else if (left.end <= right.start && left.start !== right.start) {
      merged.push(left);
      i++;
    } else if (right.end <= left.start && left.start !== right.start) {
      merged.push(right);
      j++;
    } else return null;
  }
  merged.push(...a.slice(i), ...b.slice(j));
  let offset = 0;
  const parts: string[] = [];
  for (const change of merged) {
    parts.push(base.slice(offset, change.start), change.text);
    offset = change.end;
  }
  parts.push(base.slice(offset));
  return parts.join("");
}
