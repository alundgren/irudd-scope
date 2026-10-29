import { createHash } from "node:crypto";
import { ScopeError } from "@irudd-scope/protocol";
import {
  HARNESS_FILE_FOLDERS,
  MAX_HARNESS_FILE_BYTES,
  type HarnessFileOwner,
  type HarnessFileReply,
  type HarnessId,
  type HarnessScan,
} from "@irudd-scope/protocol/harnesses";
import { readTextFile } from "./files.ts";

export type HarnessFileOptions = {
  /** The account's home folder: `HOME` on macOS and Linux, `%USERPROFILE%` on Windows. */
  home: string;
  /** The latest scan of this machine; only files it lists can be read. */
  scan: HarnessScan | null;
  harness: HarnessFileOwner;
  /** Relative to the owner's folder, for example `CLAUDE.md` or `skills/review/SKILL.md`. */
  path: string;
};

/**
 * Reads one global instruction file or one own, non-linked skill's SKILL.md that the latest
 * scan lists. Everything else is refused before it is opened. Errors never quote file text.
 */
export async function readHarnessFile(options: HarnessFileOptions): Promise<HarnessFileReply> {
  const folder = HARNESS_FILE_FOLDERS[options.harness];
  const names = relativeNames(options.path, folder);
  const path = [folder, ...names].join("/");
  const listed = allowedFiles(options.scan, options.harness);
  const entry = listed.get(names.join("/"));
  if (!entry)
    throw new ScopeError(
      403,
      `Scope does not read ${path}. Only global instruction files and own skills' SKILL.md files from the latest scan can be read.`,
    );
  if (entry !== "file")
    throw new ScopeError(
      403,
      `${entry === "linked-skill" ? `The skill folder of ${path}` : path} is linked. Scope does not follow links.`,
    );
  const read = await readTextFile(
    options.home,
    [...folder.split("/").slice(1), ...names],
    MAX_HARNESS_FILE_BYTES,
  );
  if (read.kind !== "text") throw new ScopeError(...REFUSED[read.kind](path));
  const { bytes, text } = read;
  let newlines = 0;
  for (const byte of bytes) if (byte === 10) newlines += 1;
  return {
    harness: options.harness,
    path,
    bytes: bytes.length,
    lines: bytes.length === 0 ? 0 : newlines + (bytes.at(-1) === 10 ? 0 : 1),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text,
  };
}

const REFUSED: Record<
  Exclude<Awaited<ReturnType<typeof readTextFile>>["kind"], "text">,
  (path: string) => [number, string]
> = {
  missing: (path) => [404, `${path} is gone since the latest scan. Rescan and retry.`],
  "linked-folder": (path) => [
    403,
    `A folder on the way to ${path} is linked. Scope does not follow links.`,
  ],
  "not-folder": (path) => [
    404,
    `A folder on the way to ${path} is no longer a folder. Rescan and retry.`,
  ],
  linked: (path) => [403, `${path} is linked. Scope does not follow links.`],
  "not-file": (path) => [403, `${path} is not a regular file.`],
  unopened: (path) => [403, `Scope could not open ${path}. Check its permissions.`],
  changed: (path) => [409, `${path} changed while Scope opened it. Retry.`],
  "hard-linked": (path) => [
    403,
    `${path} has more than one name. Scope does not read hard-linked files.`,
  ],
  "too-large": (path) => [403, `${path} is larger than 256 KiB. Scope does not read it.`],
  "not-text": (path) => [403, `${path} is not UTF-8 text. Scope does not return it.`],
  unreadable: (path) => [403, `Scope could not read ${path}.`],
};

/** The names below the owner's folder, refusing anything that could leave it. */
function relativeNames(path: string, folder: string): string[] {
  const hint = `Give PATH relative to ${folder} with / between names, for example ${
    folder === HARNESS_FILE_FOLDERS.shared ? "review/SKILL.md" : "skills/review/SKILL.md"
  }.`;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
    throw new ScopeError(400, `Absolute paths are not allowed. ${hint}`);
  if (path.startsWith("~"))
    throw new ScopeError(400, `Paths starting with ~ are not allowed. ${hint}`);
  if (path.includes("\\")) throw new ScopeError(400, `Backslashes are not allowed. ${hint}`);
  const names = path.split("/");
  if (names.includes("..")) throw new ScopeError(400, `Paths with .. are not allowed. ${hint}`);
  if (names.some((name) => name === "" || name === "."))
    throw new ScopeError(400, `Empty and . names are not allowed. ${hint}`);
  return names;
}

type Allowed = "file" | "linked-file" | "linked-skill";

/**
 * Each listed file by its path below the owner's folder: global instruction files and SKILL.md
 * in each own skill folder. Bundled skills are not included. Links stay listed so the refusal
 * can say why.
 */
function allowedFiles(scan: HarnessScan | null, owner: HarnessFileOwner): Map<string, Allowed> {
  if (!scan)
    throw new ScopeError(409, "No harness scan yet. Run irudd-scope harnesses scan and retry.");
  return owner === "shared" ? sharedFiles(scan) : harnessFiles(scan, owner);
}

const skillEntry = (linked: boolean): Allowed => (linked ? "linked-skill" : "file");

/** Nothing inside a linked shared folder is listed, so nothing there can be read. */
function sharedFiles(scan: HarnessScan): Map<string, Allowed> {
  const shared = scan.sharedSkills;
  if (!shared.found || shared.linked) return new Map();
  return new Map(
    shared.skills.map((entry) => [`${entry.name}/SKILL.md`, skillEntry(entry.linked)]),
  );
}

function harnessFiles(scan: HarnessScan, owner: HarnessId): Map<string, Allowed> {
  const report = scan.harnesses.find((candidate) => candidate.id === owner);
  const allowed = new Map<string, Allowed>();
  if (!report?.found) return allowed;
  const prefix = `${HARNESS_FILE_FOLDERS[owner]}/`;
  for (const file of report.instructions)
    if (file.path.startsWith(prefix))
      allowed.set(file.path.slice(prefix.length), file.linked ? "linked-file" : "file");
  for (const entry of report.skills)
    if (entry.location === "own")
      allowed.set(`skills/${entry.name}/SKILL.md`, skillEntry(entry.linked));
  return allowed;
}
