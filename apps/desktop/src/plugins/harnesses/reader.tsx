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
import { splitFrontmatter, useHarnessFile, type CopyFile, type FileText } from "./file-text.tsx";
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
  const text = file.state === "loaded" ? splitFrontmatter(file.reply.text) : null;
  return (
    <article className="harnesses-file" aria-label={item.label}>
      <div className="harnesses-file-head">
        <h3>{text?.name ?? item.label}</h3>
        {file.state === "loaded" && (
          <CopyFileText
            reply={file.reply}
            name={item.kind === "skill" ? `${item.label}/SKILL.md` : item.label}
            onCopy={onCopy}
          />
        )}
      </div>
      <code className="harnesses-muted harnesses-file-path">{item.path}</code>
      {text?.description && <p className="harnesses-muted">{text.description}</p>}
      <FileBody file={file} body={text?.body ?? ""} />
    </article>
  );
}

/** Reading…, the reason a read failed, or the Markdown without its frontmatter. */
function FileBody({ file, body }: { file: FileText; body: string }) {
  if (file.state === "loading")
    return (
      <p className="harnesses-muted" role="status">
        Reading…
      </p>
    );
  if (file.state === "failed") return <p role="alert">{file.message}</p>;
  if (!body.trim()) return <p className="harnesses-muted">The file is empty.</p>;
  return <Markdown text={body} className="harnesses-markdown" />;
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
        </nav>
        <div className="harnesses-reader-pane">
          <ChosenPane column={column} owner={owner} item={chosen} onCopy={onCopyText} />
        </div>
      </div>
    </section>
  );
}
