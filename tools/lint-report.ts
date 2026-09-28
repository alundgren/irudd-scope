import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const measurements = {
  complexity: / has a complexity of (\d+)\. Maximum allowed is \d+\.$/,
  "max-lines": /^File has too many lines \((\d+)\)\.$/,
  "max-lines-per-function": / has too many lines \((\d+)\)\. Maximum allowed is \d+\.$/,
};
type Advisory = keyof typeof measurements;

export type LintException = {
  file: string;
  // Trimmed source lines starting at the diagnostic, unique within the file.
  at?: string;
  limits: Partial<Record<Advisory, number>>;
  reason: string;
};

export type Diagnostic = {
  filename: string;
  code?: string;
  severity: string;
  message: string;
  labels?: { span: { line: number; column: number } }[];
};

function validateEntry(entry: LintException) {
  if (!entry.file || !entry.reason.trim() || !Object.keys(entry.limits).length)
    throw new Error("Each lint exception needs a file, limits, and a reason.");
}

function validateLimit(entry: LintException, rule: string, limit: number, registered: Set<string>) {
  const measurement = measurements[rule as Advisory];
  if (!measurement || !Number.isInteger(limit) || limit <= 0)
    throw new Error(`Invalid lint exception limit: ${entry.file} ${rule}.`);
  if ((rule === "max-lines") !== (entry.at === undefined))
    throw new Error(`Only max-lines exceptions can omit a source anchor: ${entry.file}.`);
  const key = `${entry.file} ${rule} ${entry.at ?? "<file>"}`;
  if (registered.has(key)) throw new Error(`Duplicate lint exception: ${key}.`);
  registered.add(key);
  return { key, measurement };
}

function anchorLine(directory: string, entry: LintException): number | undefined {
  if (entry.at === undefined) return undefined;
  let source: string;
  try {
    source = readFileSync(resolve(directory, entry.file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const lines = source.split(/\r?\n/).map((line) => line.trim());
  const length = entry.at.split("\n").length;
  const matches = lines.flatMap((_, index) =>
    lines.slice(index, index + length).join("\n") === entry.at ? [index + 1] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function reviewLint(
  diagnostics: readonly Diagnostic[],
  exceptions: readonly LintException[],
  directory: string,
) {
  const retained = new Set(diagnostics);
  const notices: string[] = [];
  const registered = new Set<string>();
  for (const entry of exceptions) {
    validateEntry(entry);
    const line = anchorLine(directory, entry);
    for (const [rule, limit] of Object.entries(entry.limits)) {
      const { key, measurement } = validateLimit(entry, rule, limit, registered);
      const matches = diagnostics.filter(
        (diagnostic) =>
          diagnostic.filename === entry.file &&
          diagnostic.code === `eslint(${rule})` &&
          (rule === "max-lines" ||
            (line !== undefined && diagnostic.labels?.[0]?.span.line === line)),
      );
      if (matches.length !== 1) {
        notices.push(`Review or remove unused or ambiguous lint exception: ${key}.`);
        continue;
      }
      const diagnostic = matches[0];
      const count = measurement.exec(diagnostic.message)?.[1];
      if (diagnostic.severity === "warning" && count !== undefined && Number(count) <= limit)
        retained.delete(diagnostic);
    }
  }
  return {
    diagnostics: [...retained],
    notices,
    accepted: diagnostics.length - retained.size,
  };
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const span = diagnostic.labels?.[0]?.span;
  const location = `${diagnostic.filename}:${span?.line ?? 1}:${span?.column ?? 1}`;
  return `${location}: ${diagnostic.message} [${diagnostic.severity}/${diagnostic.code ?? "lint"}]`;
}
