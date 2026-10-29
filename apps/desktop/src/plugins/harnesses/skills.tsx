import { Copy, X } from "lucide-react";
import { HARNESS_NAMES, type HarnessId, type HarnessScan } from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import type { MachineColumn } from "./contract.ts";

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

/**
 * "2 missing", "1 extra", "1 missing · 1 extra" or "Same" by skill folder name, compared with
 * this computer's list. Null when this computer has no list to compare with.
 */
export function difference(local: SkillList, other: SkillList) {
  if (local.state !== "listed" && local.state !== "missing") return null;
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
  linked,
  label,
}: {
  names: string[];
  row: SkillRow;
  lists: SkillList[];
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
  // With one machine nothing can differ, so the names wrap in columns without presence marks.
  if (lists.length === 1)
    return (
      <ul className="harnesses-name-list" aria-label={label}>
        {names.map((skill) => (
          <li key={skill}>{name(skill)}</li>
        ))}
      </ul>
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
  onClose,
}: {
  row: SkillRow;
  columns: MachineColumn[];
  opened: MachineColumn;
  id: string;
  onCopy: () => void;
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
  const shared = (name: string) => listed.every((list) => namesOf(list).has(name));
  const differing = names.filter((name) => !shared(name));
  const matching = names.filter(shared);
  const title = `${rowName(row)} skills on ${opened.label}`;
  return (
    <div id={id} className="harnesses-panel" role="region" aria-label={title}>
      <div className="harnesses-panel-head">
        <h3>{rowName(row)}</h3>
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
      ) : differing.length === 0 ? (
        <NameTable row={row} names={matching} lists={lists} linked={linked} label="Skill names" />
      ) : (
        <>
          <NameTable
            row={row}
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
                names={matching}
                lists={lists}
                linked={linked}
                label="Matching skills"
              />
            </details>
          )}
        </>
      )}
      {listed.some((list) => list.truncated) && (
        <p className="harnesses-muted">Some skills are left out because the list is too long.</p>
      )}
    </div>
  );
}
