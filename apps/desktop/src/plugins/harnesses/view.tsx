import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Copy, RefreshCw, Terminal } from "lucide-react";
import {
  HARNESS_IDS,
  HARNESS_NAMES,
  type HarnessId,
  type HarnessMachine,
  type HarnessScan,
} from "@irudd-scope/protocol/harnesses";
import { Button } from "../../renderer/components/ui/button.tsx";
import { localMachineName } from "../../renderer/remote-names.ts";
import { operationError } from "../../renderer/operation-error.ts";
import type { HarnessesState } from "./contract.ts";
import { HarnessCell, HarnessDetails, SharedCell, SharedDetails, scanTime } from "./details.tsx";
import "./style.css";

/** One machine column. Remote and guest columns add their own name and connection status. */
type MachineColumn = {
  machine: HarnessMachine;
  label: string;
  scan: HarnessScan | null;
  /** Sizes still pending in `scan` will not finish. */
  countFailed: boolean;
};
type Row = HarnessId | "shared";
const ROWS: readonly Row[] = [...HARNESS_IDS, "shared"];
const rowName = (row: Row) => (row === "shared" ? "Shared skills" : HARNESS_NAMES[row]);

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

type Open = { machine: HarnessMachine; row: Row } | null;

function reportOf(column: MachineColumn, row: Row) {
  const report =
    row === "shared"
      ? column.scan?.sharedSkills
      : column.scan?.harnesses.find((entry) => entry.id === row);
  return report?.found ? report : null;
}

function Cell({
  column,
  row,
  open,
  details,
  onToggle,
}: {
  column: MachineColumn;
  row: Row;
  open: Open;
  details: string;
  onToggle: (open: Open) => void;
}) {
  const report = reportOf(column, row);
  if (!report) return <span className="harnesses-muted">Not found</span>;
  const expanded = open?.machine === column.machine && open.row === row;
  return (
    <button
      type="button"
      className="harnesses-cell"
      aria-expanded={expanded}
      aria-controls={expanded ? details : undefined}
      onClick={() => onToggle(expanded ? null : { machine: column.machine, row })}
    >
      {"id" in report ? (
        <HarnessCell report={report} countFailed={column.countFailed} />
      ) : (
        <SharedCell report={report} />
      )}
    </button>
  );
}

function DetailsRow({
  column,
  row,
  span,
  details,
  onCopy,
}: {
  column: MachineColumn;
  row: Row;
  span: number;
  details: string;
  onCopy: () => void;
}) {
  const report = reportOf(column, row);
  if (!report) return null;
  const title = `${rowName(row)} on ${column.label}`;
  return (
    <tr className="harnesses-details-row">
      <td id={details} colSpan={span}>
        <div className="harnesses-details" role="region" aria-label={title}>
          <div className="harnesses-details-head">
            <h3>{title}</h3>
            <Button variant="ghost" size="sm" onClick={onCopy}>
              <Copy aria-hidden="true" />
              Copy as JSON
            </Button>
          </div>
          {"id" in report ? (
            <HarnessDetails report={report} countFailed={column.countFailed} />
          ) : (
            <SharedDetails report={report} />
          )}
        </div>
      </td>
    </tr>
  );
}

function Matrix({
  columns,
  onCopyJson,
}: {
  columns: MachineColumn[];
  onCopyJson: (machine: HarnessMachine, row: Row) => void;
}) {
  const [open, setOpen] = useState<Open>(null);
  const details = `${useId()}-details`;
  const opened = open && columns.find((column) => column.machine === open.machine);
  return (
    <>
      <div className="harnesses-scroll">
        <table className="harnesses-matrix">
          <thead>
            <tr>
              <td />
              {columns.map((column) => (
                <th key={column.machine} scope="col">
                  <span className="harnesses-machine">{column.label}</span>
                  <span className="harnesses-cell-detail">
                    {column.scan ? (
                      <>
                        Scanned{" "}
                        <time dateTime={column.scan.scannedAt}>
                          {scanTime(column.scan.scannedAt)}
                        </time>
                      </>
                    ) : (
                      "No scan yet"
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <Fragment key={row}>
                <tr>
                  <th scope="row">{rowName(row)}</th>
                  {columns.map((column) => (
                    <td key={column.machine}>
                      <Cell
                        column={column}
                        row={row}
                        open={open}
                        details={details}
                        onToggle={setOpen}
                      />
                    </td>
                  ))}
                </tr>
                {opened && open.row === row && (
                  <DetailsRow
                    column={opened}
                    row={row}
                    span={columns.length + 1}
                    details={details}
                    onCopy={() => onCopyJson(opened.machine, row)}
                  />
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="harnesses-muted harnesses-hint">Select a cell to see its details.</p>
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

  const columns: MachineColumn[] = [
    {
      machine: "local",
      label: localMachineName(window.scope.platform),
      scan: state?.reply.machines.find((scan) => scan.machine === "local") ?? null,
      countFailed: state?.countFailed ?? false,
    },
  ];
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
        <p className="harnesses-empty">
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
