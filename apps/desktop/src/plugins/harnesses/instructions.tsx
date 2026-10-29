import type { HarnessId, HarnessScan } from "@irudd-scope/protocol/harnesses";
import type { MachineColumn } from "./contract.ts";
import { LinkMark } from "./skills.tsx";

export const reportOf = (scan: HarnessScan | null, harness: HarnessId) =>
  scan?.harnesses.find((report) => report.id === harness && report.found);

export const fileName = (path: string) => path.split("/").at(-1)!;

/**
 * The instruction file names of one harness on one machine, each opening the reader. Other
 * machines say Different or Missing against this computer; fingerprints decide Different but
 * are not shown. A harness without instruction files leaves the cell empty.
 */
export function InstructionNames({
  harness,
  columns,
  index,
  buttonId,
  onOpen,
}: {
  harness: HarnessId;
  columns: MachineColumn[];
  index: number;
  buttonId: (path: string) => string;
  onOpen: (path: string) => void;
}) {
  const files = reportOf(columns[index]!.scan, harness)?.instructions ?? [];
  const local = index > 0 ? (reportOf(columns[0]!.scan, harness)?.instructions ?? []) : [];
  const missing = local.filter((file) => !files.some((other) => other.path === file.path));
  if (!files.length && !missing.length) return null;
  return (
    <ul className="harnesses-file-names">
      {files.map((file) => {
        const mine = local.find((other) => other.path === file.path);
        const different = Boolean(mine?.sha256 && file.sha256 && mine.sha256 !== file.sha256);
        return (
          <li key={file.path}>
            <button
              type="button"
              id={buttonId(file.path)}
              className="harnesses-cell"
              title={file.path}
              onClick={() => onOpen(file.path)}
            >
              <code>{fileName(file.path)}</code>
              {file.linked && <LinkMark />}
            </button>
            {different && <span className="harnesses-differs">Different</span>}
          </li>
        );
      })}
      {missing.map((file) => (
        <li key={file.path}>
          <code className="harnesses-muted">{fileName(file.path)}</code>{" "}
          <span className="harnesses-differs">Missing</span>
        </li>
      ))}
    </ul>
  );
}
