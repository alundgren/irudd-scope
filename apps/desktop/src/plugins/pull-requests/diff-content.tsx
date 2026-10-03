import { useEffect, useMemo, useState } from "react";
import type { PullRequestDetail } from "@irudd-scope/protocol/pull-requests";
import { Button } from "../../renderer/components/ui/button.tsx";
import { parseDiff, splitDiff, type DiffLine } from "./diff.ts";

function Line({ line }: { line?: DiffLine }) {
  return (
    <>
      <span className="pr-diff-sign" aria-hidden="true">
        {line?.kind === "added" ? "+" : line?.kind === "removed" ? "−" : " "}
      </span>
      <span>{line?.text}</span>
    </>
  );
}

function DiffTable({ lines, split }: { lines: DiffLine[]; split: boolean }) {
  const rows = useMemo(() => splitDiff(lines), [lines]);
  return (
    <table className={`pr-diff-table ${split ? "pr-diff-split" : ""}`} aria-label="Code changes">
      <colgroup>
        <col style={{ width: "5ch" }} />
        <col style={split ? undefined : { width: "5ch" }} />
        <col style={split ? { width: "5ch" } : undefined} />
        {split && <col />}
      </colgroup>
      {split && (
        <thead>
          <tr>
            <th colSpan={2}>Before</th>
            <th colSpan={2}>After</th>
          </tr>
        </thead>
      )}
      <tbody>
        {split
          ? rows.map((row, index) => (
              <tr key={index}>
                <td className={`pr-diff-number ${row.left?.kind ?? "empty"}`}>
                  {row.left?.before}
                </td>
                <td className={row.left?.kind ?? "empty"}>
                  <code>
                    <Line line={row.left} />
                  </code>
                </td>
                <td className={`pr-diff-number ${row.right?.kind ?? "empty"}`}>
                  {row.right?.after}
                </td>
                <td className={row.right?.kind ?? "empty"}>
                  <code>
                    <Line line={row.right} />
                  </code>
                </td>
              </tr>
            ))
          : lines.map((line, index) => (
              <tr key={index} className={line.kind}>
                <td className="pr-diff-number">{line.before}</td>
                <td className="pr-diff-number">{line.after}</td>
                <td>
                  <code>
                    <Line line={line} />
                  </code>
                </td>
              </tr>
            ))}
      </tbody>
    </table>
  );
}

export function DiffContent({
  detail,
  split,
  filesVisible,
}: {
  detail: PullRequestDetail;
  split: boolean;
  filesVisible: boolean;
}) {
  const [path, setPath] = useState<string>();
  const [limit, setLimit] = useState(2000);
  const parsed = useMemo(() => parseDiff(detail.diff), [detail.diff]);
  const files = detail.files;
  const selected = files.find((file) => file.path === path) ?? files[0];
  const diff = parsed.find((file) => file.path === selected?.path);
  useEffect(() => {
    setLimit(2000);
  }, [selected?.path, detail]);
  if (!files.length) return <div className="pr-diff-message">No changed files.</div>;
  return (
    <div className={`pr-diff-body ${filesVisible ? "" : "pr-diff-hide-files"}`}>
      {filesVisible && (
        <nav aria-label="Changed files" className="pr-diff-files">
          {files.map((file) => (
            <Button
              key={file.path}
              variant="ghost"
              title={file.path}
              aria-current={selected?.path === file.path ? "true" : undefined}
              onClick={() => setPath(file.path)}
            >
              <span>{file.path}</span>
              <small>
                <span className="pr-diff-added">+{file.additions}</span>{" "}
                <span className="pr-diff-removed">−{file.deletions}</span>
              </small>
            </Button>
          ))}
        </nav>
      )}
      <main className="pr-diff-content">
        <div className="pr-diff-file-heading">
          <strong>{selected?.path}</strong>
          <span>{selected?.status}</span>
        </div>
        {diff?.previousPath && diff.previousPath !== diff.path && (
          <div className="pr-diff-notice">Renamed from {diff.previousPath}</div>
        )}
        {diff?.lines.length ? (
          <>
            <DiffTable lines={diff.lines.slice(0, limit)} split={split} />
            {diff.lines.length > limit && (
              <Button variant="outline" onClick={() => setLimit((value) => value + 2000)}>
                Show next {Math.min(2000, diff.lines.length - limit).toLocaleString()} lines
              </Button>
            )}
          </>
        ) : (
          <p className="pr-diff-message">
            No text diff available for this file. It may be binary or contain only file metadata
            changes.
          </p>
        )}
      </main>
    </div>
  );
}
