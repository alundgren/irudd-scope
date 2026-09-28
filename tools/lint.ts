import { spawnSync } from "node:child_process";
import {
  formatDiagnostic,
  reviewLint,
  type Diagnostic,
  type LintException,
} from "./lint-report.ts";
import { lintExceptions } from "./lint-exceptions.ts";

export function runLint(directory: string, exceptions: readonly LintException[]) {
  const result = spawnSync("vp", ["lint", "--format=json"], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let diagnostics: Diagnostic[];
  try {
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report.diagnostics)) throw new Error("Missing lint diagnostics.");
    diagnostics = report.diagnostics;
  } catch {
    return {
      status: result.status || 1,
      output: result.stdout,
      errors: `${result.stderr}\nCould not read Oxlint's JSON report.\n`,
    };
  }
  const reviewed = reviewLint(diagnostics, exceptions, directory);
  const warnings = reviewed.diagnostics.filter((item) => item.severity === "warning").length;
  const errors = reviewed.diagnostics.filter((item) => item.severity === "error").length;
  const output = [
    ...reviewed.diagnostics.map(formatDiagnostic),
    ...reviewed.notices,
    `Lint: ${reviewed.accepted} reviewed advisories, ${warnings} warnings, ${errors} errors.`,
  ].join("\n");
  return { status: result.status ?? 1, output: `${output}\n`, errors: result.stderr };
}

if (import.meta.main) {
  try {
    const result = runLint(process.cwd(), lintExceptions);
    process.stdout.write(result.output);
    process.stderr.write(result.errors);
    process.exitCode = result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
