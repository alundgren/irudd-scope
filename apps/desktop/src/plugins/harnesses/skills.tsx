import { useState } from "react";
import { Copy, X } from "lucide-react";
import { HARNESS_NAMES, type HarnessId, type HarnessScan } from "@irudd-scope/protocol/harnesses";
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

export type SkillRow = HarnessId | "shared";
export const HARNESS_ROWS: readonly HarnessId[] = ["claude-code", "codex", "cursor", "grok"];
export const SKILL_ROWS: readonly SkillRow[] = [...HARNESS_ROWS, "shared"];
export const rowName = (row: SkillRow) => (row === "shared" ? "Shared skills" : HARNESS_NAMES[row]);

type Skill = { name: string; linked: boolean };
/** A harness's own skills or the shared folder's skills on one machine. */
export type SkillList =
  | { state: "listed"; folder: string; skills: readonly Skill[]; truncated: boolean }
  | { state: "missing" | "linked-folder" | "no-scan" };

export function skillList(scan: HarnessScan | null, row: SkillRow): SkillList {
  if (!scan) return { state: "no-scan" };
  if (row === "shared") {
    const shared = scan.sharedSkills;
    if (!shared.found) return { state: "missing" };
    if (shared.linked) return { state: "linked-folder" };
    return {
      state: "listed",
      folder: shared.home,
      skills: shared.skills,
      truncated: shared.truncated,
    };
  }
  const report = scan.harnesses.find((entry) => entry.id === row);
  if (!report?.found) return { state: "missing" };
  return {
    state: "listed",
    folder: `${report.home}/skills`,
    skills: report.skills.filter((skill) => skill.location === "own"),
    truncated: report.truncated,
  };
}

const UNLISTED = {
  "no-scan": "No scan",
  "linked-folder": "Linked folder",
  missing: "Not installed",
};
/** Why a cell has no skill count, for example "Not installed". */
export function unlisted(list: SkillList, row: SkillRow) {
  if (list.state === "listed") return "";
  return row === "shared" && list.state === "missing" ? "Not found" : UNLISTED[list.state];
}

const namesOf = (list: SkillList) =>
  new Set(list.state === "listed" ? list.skills.map((skill) => skill.name) : []);
/** A listed folder, or a harness or shared folder that is not there and so has no skills. */
const compared = (list: SkillList) => list.state === "listed" || list.state === "missing";

/**
 * "2 missing", "1 extra", "1 missing · 1 extra" or "Same" by skill folder name, compared with
 * this computer's list. Null when this computer has no list to compare with.
 */
export function difference(local: SkillList, other: SkillList) {
  if (!compared(local)) return null;
  const mine = namesOf(local);
  const theirs = namesOf(other);
  const missing = [...mine].filter((name) => !theirs.has(name)).length;
  const extra = [...theirs].filter((name) => !mine.has(name)).length;
  if (!missing && !extra) return { words: "Same", differs: false };
  const words = [missing && `${missing} missing`, extra && `${extra} extra`].filter(Boolean);
  return { words: words.join(" · "), differs: true };
}

export function LinkMark() {
  return (
    <span role="img" aria-label="linked" title="Linked. Scope does not read its target.">
      ↪
    </span>
  );
}

function NameCells({ name, row, lists }: { name: string; row: SkillRow; lists: SkillList[] }) {
  return lists.map((list, index) => {
    if (list.state !== "listed")
      return (
        <td key={index} className="harnesses-muted">
          {unlisted(list, row)}
        </td>
      );
    return namesOf(list).has(name) ? (
      <td key={index} className="harnesses-muted">
        <span aria-hidden="true">✓</span>
        <span className="sr-only">Present</span>
      </td>
    ) : (
      <td key={index} className="harnesses-differs">
        Missing
      </td>
    );
  });
}

function NameTable({
  names,
  row,
  lists,
  machines,
  linked,
  label,
}: {
  names: string[];
  row: SkillRow;
  lists: SkillList[];
  machines: string[];
  linked: Set<string>;
  label: string;
}) {
  const name = (skill: string) => (
    <>
      <code>{skill}</code>
      {linked.has(skill) && (
        <>
          {" "}
          <LinkMark />
        </>
      )}
    </>
  );
  return (
    <table className="harnesses-names" aria-label={label}>
      <colgroup>
        <col className="harnesses-label-col" />
        {lists.map((_, index) => (
          <col key={index} className="harnesses-machine-col" />
        ))}
        <col />
      </colgroup>
      {/* The machine headings above the panel label these columns; screen readers get them here. */}
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Skill</span>
          </th>
          {machines.map((machine) => (
            <th key={machine} scope="col">
              <span className="sr-only">{machine}</span>
            </th>
          ))}
          <td aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {names.map((skill) => (
          <tr key={skill}>
            <th scope="row">{name(skill)}</th>
            <NameCells name={skill} row={row} lists={lists} />
            <td aria-hidden="true" />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The skill names of one row on every machine. Names that differ come first, one row each with
 * a presence mark per machine; names every machine has fold behind a disclosure.
 */
export function SkillNames({
  row,
  columns,
  opened,
  id,
  onCopy,
  onCopyText,
  onClose,
}: {
  row: SkillRow;
  columns: MachineColumn[];
  opened: MachineColumn;
  id: string;
  onCopy: () => void;
  onCopyText: CopyFile;
  onClose: () => void;
}) {
  const lists = columns.map((column) => skillList(column.scan, row));
  const own = skillList(opened.scan, row);
  const listed = lists.filter((list) => list.state === "listed");
  const names = [...new Set(listed.flatMap((list) => [...namesOf(list)]))].sort((a, b) =>
    a.localeCompare(b),
  );
  const linked = new Set(
    listed.flatMap((list) =>
      list.skills.filter((skill) => skill.linked).map((skill) => skill.name),
    ),
  );
  const title = `${rowName(row)} skills on ${opened.label}`;
  return (
    <div id={id} className="harnesses-panel" role="region" aria-label={title}>
      <div className="harnesses-panel-head">
        <h4>{rowName(row)}</h4>
        {own.state === "listed" && <code className="harnesses-muted">{own.folder}</code>}
        <span className="harnesses-muted harnesses-panel-key">
          {[
            linked.size > 0 && "↪ Linked",
            columns.length > 1 && `Compared with ${columns[0]!.label}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          <Copy aria-hidden="true" />
          Copy as JSON
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close skill names" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {names.length === 0 ? (
        <p className="harnesses-muted">No skills</p>
      ) : opened.machine === "local" && own.state === "listed" ? (
        // This computer's names open their SKILL.md; other machines' files cannot be read yet.
        <SkillReader
          row={row}
          skills={own.skills}
          version={opened.scan?.scannedAt ?? ""}
          onCopyText={onCopyText}
        />
      ) : (
        <ComparedNames row={row} columns={columns} lists={lists} names={names} linked={linked} />
      )}
      {listed.some((list) => list.truncated) && (
        <p className="harnesses-muted">Some skills are left out because the list is too long.</p>
      )}
    </div>
  );
}

/** Names that differ first, one row each; names every machine has fold behind a disclosure. */
function ComparedNames({
  row,
  columns,
  lists,
  names,
  linked,
}: {
  row: SkillRow;
  columns: MachineColumn[];
  lists: SkillList[];
  names: string[];
  linked: Set<string>;
}) {
  const comparable = lists.filter(compared);
  const shared = (name: string) => comparable.every((list) => namesOf(list).has(name));
  const differing = names.filter((name) => !shared(name));
  const matching = names.filter(shared);
  const machines = columns.map((column) => column.label);
  if (differing.length === 0)
    return (
      <NameTable
        row={row}
        machines={machines}
        names={matching}
        lists={lists}
        linked={linked}
        label="Skill names"
      />
    );
  return (
    <>
      <NameTable
        row={row}
        machines={machines}
        names={differing}
        lists={lists}
        linked={linked}
        label="Skills that differ"
      />
      {matching.length > 0 && (
        <details>
          <summary>
            {matching.length} matching {matching.length === 1 ? "skill" : "skills"}
          </summary>
          <NameTable
            row={row}
            machines={machines}
            names={matching}
            lists={lists}
            linked={linked}
            label="Matching skills"
          />
        </details>
      )}
    </>
  );
}

/** Skill names as buttons; the selected skill's SKILL.md shows beside them. */
function SkillReader({
  row,
  skills,
  version,
  onCopyText,
}: {
  row: SkillRow;
  skills: readonly Skill[];
  /** The scan time; a rescan reads the selected SKILL.md again. */
  version: string;
  onCopyText: CopyFile;
}) {
  const names = skills.map((skill) => skill.name).sort((a, b) => a.localeCompare(b));
  const linked = new Set(skills.filter((skill) => skill.linked).map((skill) => skill.name));
  const [selected, setSelected] = useState<string | null>(null);
  // A rescan can remove the selected skill.
  const current = selected !== null && names.includes(selected) ? selected : null;
  return (
    <div className="harnesses-skill-reader">
      <ul className="harnesses-skill-names" aria-label="Skill names">
        {names.map((skill) => (
          <li key={skill}>
            <button
              type="button"
              className="harnesses-skill-name"
              aria-current={skill === current ? "true" : undefined}
              onClick={() => setSelected(skill)}
            >
              <code>{skill}</code>
              {linked.has(skill) && (
                <>
                  {" "}
                  <LinkMark />
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="harnesses-skill-text">
        {current === null ? (
          <p className="harnesses-muted">Select a skill to read its SKILL.md.</p>
        ) : linked.has(current) ? (
          <p className="harnesses-muted">
            <code>{current}</code> Linked. Scope does not follow it.
          </p>
        ) : (
          <SkillText key={current} row={row} name={current} version={version} onCopy={onCopyText} />
        )}
      </div>
    </div>
  );
}

function SkillText({
  row,
  name,
  version,
  onCopy,
}: {
  row: SkillRow;
  name: string;
  version: string;
  onCopy: CopyFile;
}) {
  const path = row === "shared" ? `${name}/SKILL.md` : `skills/${name}/SKILL.md`;
  const file = useHarnessFile(row, path, version);
  const label = `${name}/SKILL.md`;
  return (
    <>
      <div className="harnesses-text-head">
        <code>{label}</code>
        {file.state === "loaded" && (
          <span className="harnesses-muted">
            {formatSize(file.reply.bytes)} · {count(file.reply.lines, "line")}
          </span>
        )}
        <span className="harnesses-panel-actions">
          <CopyText file={file} name={label} onCopy={onCopy} />
        </span>
      </div>
      <FileBody file={file} label={`Text of ${label}`} />
    </>
  );
}
