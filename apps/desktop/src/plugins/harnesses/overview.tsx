import { HARNESS_FILE_FOLDERS, type HarnessMachine } from "@irudd-scope/protocol/harnesses";
import type { MachineColumn } from "./contract.ts";
import { InstructionNames } from "./instructions.tsx";
import { ScanTime } from "./scan-time.tsx";
import { SKILL_ROWS, difference, rowName, skillList, unlisted, type SkillRow } from "./skills.tsx";

/** Where the reader opens: a harness on a machine, at a file or at its first skill. */
export type ReaderTarget = { machine: HarnessMachine; owner: SkillRow; key: string | null };

/** Button ids, so Back can return focus to the button that opened the reader. */
export const openerIds = (prefix: string) => ({
  skills: (row: SkillRow, index: number) => `${prefix}-skills-${row}-${index}`,
  file: (path: string, index: number) => `${prefix}-file-${path}-${index}`,
});

/** A quiet button with the own skill count; other machines add how they differ from this one. */
function SkillCount({
  columns,
  index,
  row,
  id,
  onOpen,
}: {
  columns: MachineColumn[];
  index: number;
  row: SkillRow;
  id: string;
  onOpen: () => void;
}) {
  const list = skillList(columns[index]!.scan, row);
  if (list.state !== "listed")
    return <span className="harnesses-muted">{unlisted(list, row)}</span>;
  const compared = index > 0 ? difference(skillList(columns[0]!.scan, row), list) : null;
  const skills = list.skills.length;
  return (
    <button type="button" id={id} className="harnesses-cell" onClick={onOpen}>
      {skills}
      <span className="sr-only">{skills === 1 ? " skill" : " skills"}</span>
      {compared && (
        <span className={compared.differs ? "harnesses-differs" : "harnesses-muted"}>
          <span className="sr-only">, </span>
          {compared.words}
        </span>
      )}
    </button>
  );
}

function RowLabel({ row, columns }: { row: SkillRow; columns: MachineColumn[] }) {
  const scans = columns.flatMap((column) => column.scan ?? []);
  if (row === "codex" && scans.some((scan) => scan.sharedSkills.found))
    return (
      <>
        Codex <span className="harnesses-muted">+ Shared skills</span>
      </>
    );
  if (row !== "shared") return rowName(row);
  return (
    <>
      Shared skills{" "}
      <code className="harnesses-cell-detail">
        {scans[0]?.sharedSkills.home ?? "~/.agents/skills"}
      </code>
    </>
  );
}

/** One row per harness and the shared folder; each machine has a Skills and an Instructions column. */
export function Overview({
  columns,
  prefix,
  onOpen,
}: {
  columns: MachineColumn[];
  prefix: string;
  onOpen: (target: ReaderTarget, opener: string) => void;
}) {
  const ids = openerIds(prefix);
  return (
    <div className="harnesses-scroll">
      <table className="harnesses-matrix">
        <colgroup>
          <col className="harnesses-label-col" />
          {columns.map((column) => [
            <col key={`${column.machine}-skills`} className="harnesses-skills-col" />,
            <col key={`${column.machine}-files`} className="harnesses-files-col" />,
          ])}
          <col />
        </colgroup>
        <thead>
          <tr>
            <td className="harnesses-muted">
              {columns.length > 1 && `Compared with ${columns[0]!.label}`}
            </td>
            {columns.map((column) => (
              <th key={column.machine} scope="colgroup" colSpan={2}>
                <span className="harnesses-machine">{column.label}</span>
                <span className="harnesses-cell-detail">
                  {column.scan ? (
                    <>
                      Scanned <ScanTime iso={column.scan.scannedAt} />
                    </>
                  ) : (
                    "No scan yet"
                  )}
                </span>
              </th>
            ))}
            <td aria-hidden="true" />
          </tr>
          <tr className="harnesses-subhead">
            <td />
            {columns.map((column) => [
              <th key={`${column.machine}-skills`} scope="col">
                Skills
              </th>,
              <th key={`${column.machine}-files`} scope="col">
                Instructions
              </th>,
            ])}
            <td aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {SKILL_ROWS.map((row) => (
            <tr key={row}>
              <th scope="row">
                <RowLabel row={row} columns={columns} />
              </th>
              {columns.map((column, index) => [
                <td key={`${column.machine}-skills`}>
                  <SkillCount
                    columns={columns}
                    index={index}
                    row={row}
                    id={ids.skills(row, index)}
                    onOpen={() =>
                      onOpen(
                        { machine: column.machine, owner: row, key: null },
                        ids.skills(row, index),
                      )
                    }
                  />
                </td>,
                <td key={`${column.machine}-files`}>
                  {row !== "shared" && (
                    <InstructionNames
                      harness={row}
                      columns={columns}
                      index={index}
                      buttonId={(path) => ids.file(path, index)}
                      onOpen={(path) =>
                        onOpen(
                          {
                            machine: column.machine,
                            owner: row,
                            key: path.slice(HARNESS_FILE_FOLDERS[row].length + 1),
                          },
                          ids.file(path, index),
                        )
                      }
                    />
                  )}
                </td>,
              ])}
              <td aria-hidden="true" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
