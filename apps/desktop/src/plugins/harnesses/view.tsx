import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import {
  HARNESS_FILE_FOLDERS,
  type HarnessMachine,
  type HarnessScan,
} from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import { localMachineName } from "../../renderer/remote-names.ts";
import { operationError } from "../../renderer/operation-error.ts";
import type { HarnessesState, MachineColumn } from "./contract.ts";
import type { CopyFile } from "./file-text.tsx";
import { Overview, type ReaderTarget } from "./overview.tsx";
import { Reader, readerItems } from "./reader.tsx";
import { rowName, skillList, type SkillRow } from "./skills.tsx";
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

const FILE_CHANGED = "The file changed since it was shown; copied the current text.";

/** The chosen file, the first skill when opened from a count, or the first file. */
function chosenItem(items: ReturnType<typeof readerItems>, target: ReaderTarget) {
  return (
    items.find((item) => item.key === target.key) ??
    items.find((item) => item.kind === "skill") ??
    items[0]
  );
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
  /** `action` can resolve with a message that replaces `done`. */
  function copy(action: Promise<string | void>, done: string) {
    action.then(
      (message) => announce(message ?? done),
      (error: unknown) => announce(operationError(error, "Could not copy. Retry.")),
    );
  }
  const rescan = () =>
    void window.scope.scanHarnesses().catch(() => announce("Could not start a scan. Retry."));

  const columns = machineColumns(state);
  const scanned = columns.filter((column) => column.scan);
  const prefix = useId();
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  const opener = useRef<string | null>(null);
  // A rescan that removes the harness or folder being read returns to the overview.
  const gone =
    reader !== null &&
    !columns.some(
      (column) =>
        column.machine === reader.machine &&
        skillList(column.scan, reader.owner).state === "listed",
    );
  useEffect(() => {
    if (gone) setReader(null);
  }, [gone]);
  useEffect(() => {
    if (reader || !opener.current) return;
    document.getElementById(opener.current)?.focus();
    opener.current = null;
  }, [reader]);
  function open(target: ReaderTarget, id: string) {
    opener.current = id;
    setReader(target);
  }
  function back() {
    setReader(null);
  }
  const copyJson = (machine: HarnessMachine, row: SkillRow) =>
    copy(
      window.scope.copyHarnessJson({ machine, harness: row }),
      `Copied ${rowName(row)} as JSON.`,
    );
  const copyText: CopyFile = ({ harness, path, sha256 }, name) =>
    copy(
      window.scope
        .copyHarnessFile({
          machine: "local",
          harness,
          path: path.slice(HARNESS_FILE_FOLDERS[harness].length + 1),
          shown: sha256,
        })
        .then(({ changed }) => (changed ? FILE_CHANGED : undefined)),
      `Copied the text of ${name}.`,
    );

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
    const column = reader && columns.find((candidate) => candidate.machine === reader.machine);
    if (reader && column) {
      const items = readerItems(column.scan, reader.owner);
      return (
        <Reader
          column={column}
          owner={reader.owner}
          items={items}
          chosen={chosenItem(items, reader)}
          onChoose={(key) => setReader({ ...reader, key })}
          onBack={back}
          onCopyJson={() => copyJson(reader.machine, reader.owner)}
          onCopyText={copyText}
        />
      );
    }
    return <Overview columns={columns} prefix={prefix} onOpen={open} />;
  }

  return (
    <div className={reader ? "harnesses-view harnesses-view-reading" : "harnesses-view"}>
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
