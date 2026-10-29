import { Fragment, useEffect, useId, useRef, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import type { HarnessMachine, HarnessScan } from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import { localMachineName } from "../../renderer/remote-names.ts";
import { operationError } from "../../renderer/operation-error.ts";
import type { HarnessesState, MachineColumn } from "./contract.ts";
import type { CopyFile } from "./file-text.tsx";
import {
  InstructionCell,
  InstructionText,
  instructionRows,
  readable,
  withoutInstructions,
  type InstructionRow,
  type TextToggle,
} from "./instructions.tsx";
import { ScanTime } from "./scan-time.tsx";
import {
  SKILL_ROWS,
  SkillNames,
  difference,
  rowName,
  skillList,
  unlisted,
  type SkillRow,
} from "./skills.tsx";
import "./style.css";

function useHarnesses() {
  const [state, setState] = useState<HarnessesState>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    let observed = false;
    const stop = window.scope.onHarnessesChange((next) => {
      observed = true;
      if (current) {
        setState(next);
        setFailed(false);
      }
    });
    void window.scope
      .harnesses()
      .then((next) => {
        if (current && !observed) setState(next);
      })
      .catch(() => {
        if (current && !observed) setFailed(true);
      });
    return () => {
      current = false;
      stop();
    };
  }, []);
  return { state, failed };
}

/** One panel at a time: a row's skill names, or an instruction file's text. */
type Open =
  | { kind: "skills"; machine: HarnessMachine; row: SkillRow }
  | { kind: "file"; machine: HarnessMachine; file: InstructionRow }
  | null;

/** A quiet button with the own skill count; other machines add how they differ from this one. */
function SkillCount({
  columns,
  index,
  row,
  open,
  panel,
  onToggle,
}: {
  columns: MachineColumn[];
  index: number;
  row: SkillRow;
  open: Open;
  panel: string;
  onToggle: (open: Open) => void;
}) {
  const column = columns[index]!;
  const list = skillList(column.scan, row);
  if (list.state !== "listed")
    return <span className="harnesses-muted">{unlisted(list, row)}</span>;
  const compared = index > 0 ? difference(skillList(columns[0]!.scan, row), list) : null;
  const expanded = open?.kind === "skills" && open.machine === column.machine && open.row === row;
  const skills = list.skills.length;
  return (
    <button
      type="button"
      id={`${panel}-${row}-${index}`}
      className="harnesses-cell"
      aria-expanded={expanded}
      aria-controls={expanded ? panel : undefined}
      onClick={() => onToggle(expanded ? null : { kind: "skills", machine: column.machine, row })}
    >
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

function BlockHead({ title, note, span }: { title: string; note: string; span: number }) {
  return (
    <tr className="harnesses-block-head">
      <th scope="rowgroup">
        <h3>{title}</h3>
      </th>
      <td colSpan={span} className="harnesses-muted">
        {note}
      </td>
    </tr>
  );
}

/** Instruction file rows; the open file's text shows below its row. */
function InstructionBlock({
  files,
  columns,
  open,
  opened,
  panel,
  toggle,
  onCopyText,
  onClose,
}: {
  files: InstructionRow[];
  columns: MachineColumn[];
  open: Open;
  opened: MachineColumn | null | undefined;
  panel: string;
  toggle: (file: InstructionRow, column: MachineColumn, index: number) => TextToggle | undefined;
  onCopyText: CopyFile;
  onClose: () => void;
}) {
  const span = columns.length + 2;
  return (
    <tbody>
      <BlockHead title="Instruction files" note="Same fingerprint, same text" span={span - 1} />
      {files.map((file) => (
        <Fragment key={file.path}>
          <tr>
            <th scope="row">
              {rowName(file.harness)} <code className="harnesses-cell-detail">{file.path}</code>
            </th>
            {columns.map((column, index) => (
              <td key={column.machine}>
                <InstructionCell
                  row={file}
                  columns={columns}
                  index={index}
                  toggle={toggle(file, column, index)}
                />
              </td>
            ))}
            <td aria-hidden="true" />
          </tr>
          {opened && open?.kind === "file" && open.file.path === file.path && (
            <tr className="harnesses-panel-row">
              <td colSpan={span}>
                <InstructionText
                  row={file}
                  column={opened}
                  id={panel}
                  onCopy={onCopyText}
                  onClose={onClose}
                />
              </td>
            </tr>
          )}
        </Fragment>
      ))}
    </tbody>
  );
}

/** Whether the opened panel's skill list or file is still in its machine's latest scan. */
function stillListed(open: NonNullable<Open>, column: MachineColumn) {
  if (column.machine !== open.machine) return false;
  return open.kind === "skills"
    ? skillList(column.scan, open.row).state === "listed"
    : readable(column.scan, open.file);
}

function Matrix({
  columns,
  onCopyJson,
  onCopyText,
}: {
  columns: MachineColumn[];
  onCopyJson: (machine: HarnessMachine, row: SkillRow) => void;
  onCopyText: CopyFile;
}) {
  const [open, setOpen] = useState<Open>(null);
  const panel = `${useId()}-skills`;
  // A rescan can remove the opened harness, folder or file; its panel then closes.
  const opened = open && columns.find((column) => stillListed(open, column));
  const stale = Boolean(open && !opened);
  useEffect(() => {
    if (stale) setOpen(null);
  }, [stale]);
  const span = columns.length + 2;
  const files = instructionRows(columns);
  const footnote = withoutInstructions(columns);
  const sharedFolder = columns.find((column) => column.scan)?.scan?.sharedSkills;
  const shared = columns.some((column) => column.scan?.sharedSkills.found);
  const fileButton = (file: InstructionRow, index: number) => `${panel}-file-${file.path}-${index}`;
  /** Only this computer's files can be read for now. */
  function fileToggle(
    file: InstructionRow,
    column: MachineColumn,
    index: number,
  ): TextToggle | undefined {
    if (column.machine !== "local") return undefined;
    const expanded =
      open?.kind === "file" && open.machine === column.machine && open.file.path === file.path;
    return {
      id: fileButton(file, index),
      expanded,
      controls: `${panel}-file`,
      onToggle: () => setOpen(expanded ? null : { kind: "file", machine: column.machine, file }),
    };
  }
  function close() {
    if (!open) return;
    const index = columns.findIndex((column) => column.machine === open.machine);
    setOpen(null);
    document
      .getElementById(
        open.kind === "skills" ? `${panel}-${open.row}-${index}` : fileButton(open.file, index),
      )
      ?.focus();
  }
  const colgroup = (
    <colgroup>
      <col className="harnesses-label-col" />
      {columns.map((column) => (
        <col key={column.machine} className="harnesses-machine-col" />
      ))}
      <col />
    </colgroup>
  );
  return (
    <>
      <div className="harnesses-scroll">
        <table className="harnesses-matrix">
          {colgroup}
          <thead>
            <tr>
              <td className="harnesses-muted">
                {columns.length > 1 && `Compared with ${columns[0]!.label}`}
              </td>
              {columns.map((column) => (
                <th key={column.machine} scope="col">
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
          </thead>
          <tbody>
            <BlockHead title="Skills" note="Own folders" span={span - 1} />
            {SKILL_ROWS.map((row) => (
              <Fragment key={row}>
                <tr>
                  <th scope="row">
                    {rowName(row)}
                    {row === "codex" && shared && (
                      <span className="harnesses-muted"> + Shared skills</span>
                    )}
                  </th>
                  {columns.map((column, index) => (
                    <td key={column.machine}>
                      <SkillCount
                        columns={columns}
                        index={index}
                        row={row}
                        open={open}
                        panel={panel}
                        onToggle={setOpen}
                      />
                    </td>
                  ))}
                  <td aria-hidden="true" />
                </tr>
                {opened && open.kind === "skills" && open.row === row && (
                  <tr className="harnesses-panel-row">
                    <td colSpan={span}>
                      <SkillNames
                        row={row}
                        columns={columns}
                        opened={opened}
                        id={panel}
                        onCopy={() => onCopyJson(opened.machine, row)}
                        onCopyText={onCopyText}
                        onClose={close}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {files.length > 0 && (
            <InstructionBlock
              files={files}
              columns={columns}
              open={open}
              opened={opened}
              panel={`${panel}-file`}
              toggle={fileToggle}
              onCopyText={onCopyText}
              onClose={close}
            />
          )}
        </table>
      </div>
      <footer className="harnesses-footer harnesses-muted">
        <span>{footnote ?? (files.length ? "" : "No instruction files.")}</span>
        {sharedFolder && <code>Shared skills · {sharedFolder.home}</code>}
      </footer>
    </>
  );
}

function NothingFound({ column }: { column: MachineColumn }) {
  const scan = column.scan!;
  const folders = [...scan.harnesses.map((report) => report.home), scan.sharedSkills.home];
  return (
    <div className="harnesses-empty">
      <p>No harnesses found in their default locations on {column.label}.</p>
      <p className="harnesses-muted">
        Scope looked in {folders.slice(0, -1).join(", ")} and {folders.at(-1)}.
      </p>
    </div>
  );
}

function machineColumns(state: HarnessesState | undefined): MachineColumn[] {
  return [
    {
      machine: "local",
      label: localMachineName(window.scope.platform),
      scan: state?.reply.machines.find((scan) => scan.machine === "local") ?? null,
    },
  ];
}

const nothingFound = (scan: HarnessScan) =>
  !scan.sharedSkills.found && scan.harnesses.every((report) => !report.found);

export function HarnessesView() {
  const { state, failed } = useHarnesses();
  const [notice, setNotice] = useState("");
  const clearNotice = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clearNotice.current), []);

  function announce(text: string) {
    clearTimeout(clearNotice.current);
    setNotice(text);
    clearNotice.current = setTimeout(() => setNotice(""), 4000);
  }
  function copy(action: Promise<void>, done: string) {
    action.then(
      () => announce(done),
      (error: unknown) => announce(operationError(error, "Could not copy. Retry.")),
    );
  }
  const rescan = () =>
    void window.scope.scanHarnesses().catch(() => announce("Could not start a scan. Retry."));

  const columns = machineColumns(state);
  const scanned = columns.filter((column) => column.scan);

  function body() {
    if (!state)
      return failed ? (
        <p role="alert">Could not load harnesses. Close and reopen the tab to retry.</p>
      ) : (
        <p role="status">Loading…</p>
      );
    if (!scanned.length) {
      if (state.error) return null;
      return (
        <p className="harnesses-empty" role="status">
          {state.scanning ? `Scanning ${columns[0]!.label}…` : "No scan yet. Select Rescan."}
        </p>
      );
    }
    if (scanned.every((column) => nothingFound(column.scan!)))
      return <NothingFound column={scanned[0]!} />;
    return (
      <Matrix
        columns={columns}
        onCopyJson={(machine, row) =>
          copy(
            window.scope.copyHarnessJson({ machine, harness: row }),
            `Copied ${rowName(row)} as JSON.`,
          )
        }
        onCopyText={(harness, path, name) =>
          copy(
            window.scope.copyHarnessFile({ machine: "local", harness, path }),
            `Copied the text of ${name}.`,
          )
        }
      />
    );
  }

  return (
    <div className="harnesses-view">
      <div className="harnesses-toolbar">
        <h2>Harnesses</h2>
        <span className="harnesses-muted" role="status">
          {state?.scanning && scanned.length > 0 ? "Scanning…" : ""}
        </span>
        <span className="harnesses-notice" role="status">
          {notice}
        </span>
        <div className="harnesses-actions">
          <Button
            variant="outline"
            onClick={() => copy(window.scope.copyHarnessesRequest(), "Copied the agent request.")}
          >
            <Terminal aria-hidden="true" />
            Copy agent request
          </Button>
          <Button variant="outline" onClick={rescan}>
            <RefreshCw aria-hidden="true" />
            Rescan
          </Button>
        </div>
      </div>
      {state?.error && (
        <div role="alert" className="harnesses-error">
          <p>{state.error}</p>
          <Button variant="secondary" onClick={rescan}>
            Retry
          </Button>
        </div>
      )}
      {body()}
    </div>
  );
}
