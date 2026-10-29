import { HARNESS_NAMES, type HarnessId, type HarnessScan } from "@irudd-scope/protocol/harnesses";

export type SkillRow = HarnessId | "shared";
export const HARNESS_ROWS: readonly HarnessId[] = ["claude-code", "codex", "cursor", "grok"];
export const SKILL_ROWS: readonly SkillRow[] = [...HARNESS_ROWS, "shared"];
export const rowName = (row: SkillRow) => (row === "shared" ? "Shared skills" : HARNESS_NAMES[row]);

export type Skill = { name: string; linked: boolean };
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
