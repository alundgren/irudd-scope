import { X } from "lucide-react";
import {
  HARNESS_FILE_FOLDERS,
  HARNESS_NAMES,
  type HarnessId,
  type HarnessInstructionFile,
  type HarnessScan,
} from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import type { MachineColumn } from "./contract.ts";
import {
  CopyText,
  FileBody,
  count,
  formatSize,
  useHarnessFile,
  type CopyFile,
} from "./file-text.tsx";
import { HARNESS_ROWS, LinkMark } from "./skills.tsx";

export type InstructionRow = { harness: HarnessId; path: string };

const reportOf = (scan: HarnessScan | null, harness: HarnessId) =>
  scan?.harnesses.find((report) => report.id === harness && report.found);
const fileOf = (scan: HarnessScan | null, row: InstructionRow) =>
  reportOf(scan, row.harness)?.instructions.find((file) => file.path === row.path);
/** A file the scan fingerprinted, so its text can be read; linked files are never read. */
export const readable = (scan: HarnessScan | null, row: InstructionRow) => {
  const file = fileOf(scan, row);
  return Boolean(file && !file.linked && file.sha256);
};

/** The fingerprint button that opens a file's text below its row. */
export type TextToggle = { id: string; expanded: boolean; controls: string; onToggle: () => void };

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
  toggle,
}: {
  row: InstructionRow;
  columns: MachineColumn[];
  index: number;
  toggle?: TextToggle;
}) {
  const column = columns[index]!;
  if (!column.scan) return <span className="harnesses-muted">No scan</span>;
  const file = fileOf(column.scan, row);
  const local = index > 0 ? fileOf(columns[0]!.scan, row) : undefined;
  if (!file) return <MissingFile column={column} row={row} local={local !== undefined} />;
  return <FileFacts file={file} local={local} toggle={toggle} />;
}

/** A quiet button that opens the file's text when it can be read, otherwise plain text. */
function Fingerprint({
  sha256,
  different,
  toggle,
}: {
  sha256: string;
  different: boolean;
  toggle?: TextToggle;
}) {
  if (!toggle || !sha256)
    return (
      <code className={different ? "harnesses-differs" : undefined}>{sha256.slice(0, 8)}</code>
    );
  return (
    <button
      type="button"
      id={toggle.id}
      className="harnesses-cell"
      aria-expanded={toggle.expanded}
      aria-controls={toggle.expanded ? toggle.controls : undefined}
      onClick={toggle.onToggle}
    >
      <code className={different ? "harnesses-differs" : undefined}>{sha256.slice(0, 8)}</code>
      <span className="sr-only"> Show text</span>
    </button>
  );
}

function FileFacts({
  file,
  local,
  toggle,
}: {
  file: HarnessInstructionFile;
  local?: HarnessInstructionFile;
  toggle?: TextToggle;
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
        <Fingerprint sha256={sha256} different={different} toggle={toggle} />
        {different && <span className="harnesses-differs">· Different</span>}
      </span>
      <span className="harnesses-cell-detail">
        {formatSize(file.bytes ?? 0)} · {count(file.lines ?? 0, "line")}
      </span>
    </>
  );
}

/** One instruction file's text below its row, read when the panel opens. */
export function InstructionText({
  row,
  column,
  id,
  onCopy,
  onClose,
}: {
  row: InstructionRow;
  column: MachineColumn;
  id: string;
  onCopy: CopyFile;
  onClose: () => void;
}) {
  const path = row.path.slice(HARNESS_FILE_FOLDERS[row.harness].length + 1);
  const scanned = fileOf(column.scan, row)?.sha256 ?? "";
  const file = useHarnessFile(row.harness, path, scanned);
  const name = row.path.split("/").at(-1)!;
  const fingerprint = file.state === "loaded" ? file.reply.sha256 : scanned;
  return (
    <div
      id={id}
      className="harnesses-panel"
      role="region"
      aria-label={`${name} on ${column.label}`}
    >
      <div className="harnesses-panel-head">
        <h4>{name}</h4>
        <code className="harnesses-muted">
          {[row.path, column.label, fingerprint?.slice(0, 8)].filter(Boolean).join(" · ")}
        </code>
        <span className="harnesses-panel-actions">
          <CopyText file={file} name={name} onCopy={onCopy} />
          <Button variant="ghost" size="icon-sm" aria-label="Close text" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </span>
      </div>
      <div className="harnesses-panel-body">
        <FileBody file={file} label={`Text of ${name}`} />
      </div>
    </div>
  );
}
