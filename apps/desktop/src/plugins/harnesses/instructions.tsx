import {
  HARNESS_NAMES,
  type HarnessId,
  type HarnessInstructionFile,
  type HarnessScan,
} from "@irudd-scope/protocol/harnesses";
import type { MachineColumn } from "./contract.ts";
import { HARNESS_ROWS, LinkMark } from "./skills.tsx";

const UNITS = ["KB", "MB", "GB", "TB"];
/** Decimal units like a file manager: one decimal below 100, none from 100 up, so 405 MB and 11.6 GB. */
function formatSize(size: number) {
  if (size < 1000) return count(size, "byte");
  for (const [index, unit] of UNITS.entries()) {
    const value = size / 1000 ** (index + 1);
    const text = value < 99.95 ? value.toFixed(1) : value.toFixed(0);
    if (Number(text) < 1000 || index === UNITS.length - 1) return `${text} ${unit}`;
  }
  return count(size, "byte");
}
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type InstructionRow = { harness: HarnessId; path: string };

const reportOf = (scan: HarnessScan | null, harness: HarnessId) =>
  scan?.harnesses.find((report) => report.id === harness && report.found);
const fileOf = (scan: HarnessScan | null, row: InstructionRow) =>
  reportOf(scan, row.harness)?.instructions.find((file) => file.path === row.path);

/** One row per instruction file path that any machine has, in harness order. */
export function instructionRows(columns: MachineColumn[]): InstructionRow[] {
  return HARNESS_ROWS.flatMap((harness) => {
    const paths = columns.flatMap(
      (column) => reportOf(column.scan, harness)?.instructions.map((file) => file.path) ?? [],
    );
    return [...new Set(paths)].map((path) => ({ harness, path }));
  });
}

/** "Cursor and Grok Build have no instruction files." for harnesses found without any. */
export function withoutInstructions(columns: MachineColumn[]) {
  const names = HARNESS_ROWS.filter((harness) => {
    const reports = columns.flatMap((column) => reportOf(column.scan, harness) ?? []);
    return reports.length > 0 && reports.every((report) => !report.instructions.length);
  }).map((harness) => HARNESS_NAMES[harness]);
  if (!names.length) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "has" : "have"} no instruction files.`;
}

function MissingFile({
  column,
  row,
  local,
}: {
  column: MachineColumn;
  row: InstructionRow;
  local: boolean;
}) {
  if (local) return <span className="harnesses-differs">Missing</span>;
  return (
    <span className="harnesses-muted">
      {reportOf(column.scan, row.harness) ? "No file" : "Not installed"}
    </span>
  );
}

/** Fingerprint, size and lines; other machines say Different or Missing against this computer. */
export function InstructionCell({
  row,
  columns,
  index,
}: {
  row: InstructionRow;
  columns: MachineColumn[];
  index: number;
}) {
  const column = columns[index]!;
  if (!column.scan) return <span className="harnesses-muted">No scan</span>;
  const file = fileOf(column.scan, row);
  const local = index > 0 ? fileOf(columns[0]!.scan, row) : undefined;
  if (!file) return <MissingFile column={column} row={row} local={local !== undefined} />;
  return <FileFacts file={file} local={local} />;
}

function FileFacts({
  file,
  local,
}: {
  file: HarnessInstructionFile;
  local?: HarnessInstructionFile;
}) {
  if (file.linked)
    return (
      <span className="harnesses-muted">
        <LinkMark /> Linked file
      </span>
    );
  const sha256 = file.sha256 ?? "";
  const different = Boolean(local?.sha256) && local!.sha256 !== sha256;
  return (
    <>
      <span className="harnesses-cell-line">
        <code className={different ? "harnesses-differs" : undefined}>{sha256.slice(0, 8)}</code>
        {different && <span className="harnesses-differs">· Different</span>}
      </span>
      <span className="harnesses-cell-detail">
        {formatSize(file.bytes ?? 0)} · {count(file.lines ?? 0, "line")}
      </span>
    </>
  );
}
