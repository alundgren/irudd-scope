import { useEffect, useRef } from "react";
import { ArrowLeft, Copy } from "lucide-react";
import {
  HARNESS_FILE_FOLDERS,
  type HarnessFileReply,
  type HarnessScan,
} from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Markdown } from "../../renderer/markdown.tsx";
import type { MachineColumn } from "./contract.ts";
import type { Components } from "react-markdown";
import {
  splitFrontmatter,
  useHarnessFile,
  type CopyFile,
  type FileText,
  type Frontmatter,
} from "./file-text.tsx";
import { fileName, reportOf } from "./instructions.tsx";
import { LinkMark, rowName, skillList, type SkillRow } from "./skills.tsx";

/** One readable file of a harness, or of the shared skill folder, on one machine. */
export type ReaderItem = {
  /** The path below the owner's folder, as `harnesses file` names it. */
  key: string;
  label: string;
  /** Written from `~`. */
  path: string;
  kind: "instruction" | "skill";
  linked: boolean;
  /** Changes when a rescan may have found new text. */
  version: string;
};

/** Instruction files first, then own skills; the shared folder has only skills. */
export function readerItems(scan: HarnessScan | null, owner: SkillRow): ReaderItem[] {
  const folder = HARNESS_FILE_FOLDERS[owner];
  const list = skillList(scan, owner);
  if (!scan || list.state !== "listed") return [];
  const instructions = owner === "shared" ? [] : (reportOf(scan, owner)?.instructions ?? []);
  const skillPath = (name: string) => (owner === "shared" ? name : `skills/${name}`);
  return [
    ...instructions.map((file) => ({
      key: file.path.slice(folder.length + 1),
      label: fileName(file.path),
      path: file.path,
      kind: "instruction" as const,
      linked: file.linked,
      version: file.sha256 ?? "",
    })),
    ...[...list.skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        key: `${skillPath(skill.name)}/SKILL.md`,
        label: skill.name,
        path: `${folder}/${skillPath(skill.name)}/SKILL.md`,
        kind: "skill" as const,
        linked: skill.linked,
        version: scan.scannedAt,
      })),
  ];
}

function ItemList({
  items,
  chosen,
  label,
  onChoose,
}: {
  items: ReaderItem[];
  chosen: ReaderItem | undefined;
  label: string;
  onChoose: (key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <>
      <p className="harnesses-list-label">{label}</p>
      <ul aria-label={label}>
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="harnesses-reader-item"
              aria-current={item === chosen ? "true" : undefined}
              onClick={() => onChoose(item.key)}
            >
              <code>{item.label}</code>
              {item.linked && <LinkMark />}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The chosen file: its title, path and Copy file text, then the rendered Markdown. */
function FilePane({
  item,
  owner,
  onCopy,
}: {
  item: ReaderItem;
  owner: SkillRow;
  onCopy: CopyFile;
}) {
  const file = useHarnessFile(owner, item.key, item.version);
  const text = file.state === "loaded" ? readerText(item, file.reply.text) : UNREAD;
  return (
    <article className="harnesses-file" aria-label={item.label}>
      <FileHead item={item} file={file} name={text.name} onCopy={onCopy} />
      <code className="harnesses-muted harnesses-file-path">{item.path}</code>
      {text.description && <p className="harnesses-muted">{text.description}</p>}
      <FileBody file={file} body={text.body} described={Boolean(text.name || text.description)} />
    </article>
  );
}

/** The file's title with Copy file text beside it. */
function FileHead({
  item,
  file,
  name,
  onCopy,
}: {
  item: ReaderItem;
  file: FileText;
  name: string | null;
  onCopy: CopyFile;
}) {
  // A skill's title comes from its frontmatter, so it waits for the text instead of changing.
  const title = name ?? (item.kind === "skill" && file.state === "loading" ? null : item.label);
  return (
    <div className="harnesses-file-head">
      {title && <h3>{title}</h3>}
      {file.state === "loaded" && (
        <CopyFileText
          reply={file.reply}
          name={item.kind === "skill" ? `${item.label}/SKILL.md` : item.label}
          onCopy={onCopy}
        />
      )}
    </div>
  );
}

const UNREAD: Frontmatter = { name: null, description: null, body: "" };

/** Only a SKILL.md has frontmatter; instruction files show all their text. */
function readerText(item: ReaderItem, text: string): Frontmatter {
  return item.kind === "skill"
    ? splitFrontmatter(text)
    : { name: null, description: null, body: text };
}

/** Markdown headings sit below the pane's h3 title, so h1 becomes h4 and the rest follow. */
const heading =
  (level: number): NonNullable<Components["h1"]> =>
  ({ children }) => {
    const Tag = `h${Math.min(level + 3, 6)}` as "h4" | "h5" | "h6";
    return <Tag>{children}</Tag>;
  };
const HEADINGS: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
};

/** Reading…, the reason a read failed, or the Markdown without its frontmatter. */
function FileBody({
  file,
  body,
  described,
}: {
  file: FileText;
  body: string;
  /** A frontmatter name or description already shows, so an empty body says nothing. */
  described: boolean;
}) {
  if (file.state === "loading")
    return (
      <p className="harnesses-muted" role="status">
        Reading…
      </p>
    );
  if (file.state === "failed") return <p role="alert">{file.message}</p>;
  if (!body.trim()) return described ? null : <p className="harnesses-muted">The file is empty.</p>;
  return <Markdown text={body} className="harnesses-markdown" components={HEADINGS} />;
}

function CopyFileText({
  reply,
  name,
  onCopy,
}: {
  reply: HarnessFileReply;
  name: string;
  onCopy: CopyFile;
}) {
  return (
    <Button variant="outline" size="sm" onClick={() => onCopy(reply, name)}>
      <Copy aria-hidden="true" />
      Copy file text
    </Button>
  );
}

function ChosenPane({
  column,
  owner,
  item,
  onCopy,
}: {
  column: MachineColumn;
  owner: SkillRow;
  item: ReaderItem | undefined;
  onCopy: CopyFile;
}) {
  if (!item) return <p className="harnesses-muted">Nothing here to read.</p>;
  if (item.linked)
    return (
      <article className="harnesses-file" aria-label={item.label}>
        <div className="harnesses-file-head">
          <h3>{item.label}</h3>
        </div>
        <code className="harnesses-muted harnesses-file-path">{item.path}</code>
        <p>Linked. Scope does not follow it.</p>
      </article>
    );
  if (column.machine !== "local")
    return <p className="harnesses-muted">Scope reads files only on this computer.</p>;
  return <FilePane key={item.key} item={item} owner={owner} onCopy={onCopy} />;
}

/**
 * The files of one harness, or of the shared skill folder, on one machine, filling the tab.
 * The top bar belongs to the harness; the file's own heading and Copy file text sit in the
 * pane on the right.
 */
export function Reader({
  column,
  owner,
  items,
  chosen,
  onChoose,
  onBack,
  onCopyJson,
  onCopyText,
}: {
  column: MachineColumn;
  owner: SkillRow;
  items: ReaderItem[];
  chosen: ReaderItem | undefined;
  onChoose: (key: string) => void;
  onBack: () => void;
  onCopyJson: () => void;
  onCopyText: CopyFile;
}) {
  const name = rowName(owner);
  const skills = skillList(column.scan, owner);
  // Some skills were left out of the scan to keep it small.
  const truncated = skills.state === "listed" && skills.truncated;
  const list = useRef<HTMLElement>(null);
  // The button that opened the reader is gone, so focus moves to the chosen file.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  }, []);
  return (
    <section
      className="harnesses-reader"
      aria-label={`${name} on ${column.label}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onBack();
      }}
    >
      <div className="harnesses-reader-bar">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        <h2>
          {name} <span className="harnesses-muted">on {column.label}</span>
        </h2>
        <Button variant="ghost" className="harnesses-reader-json" onClick={onCopyJson}>
          <Copy aria-hidden="true" />
          Copy {name} as JSON
        </Button>
      </div>
      <div className="harnesses-reader-body">
        <nav ref={list} className="harnesses-reader-list" aria-label={`${name} files`}>
          <ItemList
            label="Instructions"
            items={items.filter((item) => item.kind === "instruction")}
            chosen={chosen}
            onChoose={onChoose}
          />
          <ItemList
            label="Skills"
            items={items.filter((item) => item.kind === "skill")}
            chosen={chosen}
            onChoose={onChoose}
          />
          {truncated && (
            <p className="harnesses-muted harnesses-list-note">
              Some skills are left out because the list is too long.
            </p>
          )}
        </nav>
        {/* The pane scrolls and keeps focus after a click in the text, so Escape still works. */}
        <div
          className="harnesses-reader-pane"
          role="region"
          aria-label={chosen ? `${chosen.label} file` : "File"}
          tabIndex={0}
        >
          <ChosenPane column={column} owner={owner} item={chosen} onCopy={onCopyText} />
        </div>
      </div>
    </section>
  );
}
