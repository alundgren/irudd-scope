import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useRemotes } from "../../renderer/remote-names.ts";
import type { TabContext } from "../api.ts";
import type { Tab } from "../../workspace/contract.ts";
import { FolderTabState, type FolderTabData } from "./contract.ts";
import { useFolder, type FolderStatus } from "./use-folder.ts";
import { FolderTree, filteredRows, folderRows } from "./tree.tsx";
import { FolderSearch, filterStatus, useFolderFilter } from "./find-panel.tsx";
import { FolderPreview } from "./preview.tsx";

function Unavailable({
  status,
  machine,
  path,
  onClose,
}: {
  status: FolderStatus;
  machine: string;
  path: string;
  onClose: () => void;
}) {
  if (status.kind === "loading")
    return (
      <p className="folder-state" role="status">
        Reading folder…
      </p>
    );
  const message =
    status.kind === "gone"
      ? "This folder no longer exists"
      : status.kind === "offline"
        ? `${machine} is offline`
        : status.kind === "update"
          ? `Update Scope on ${machine} to view this folder`
          : (status.message ?? "Could not read this folder.");
  return (
    <div className="folder-state" role={status.kind === "error" ? "alert" : "status"}>
      <p>{message}</p>
      <code>{path}</code>
      {status.kind === "gone" && (
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      )}
    </div>
  );
}

export function FolderView({
  tab,
  context,
  active,
}: {
  tab: Tab;
  context: TabContext;
  active: boolean;
}) {
  const data = decode(FolderTabState, tab.state).data;
  const remotes = useRemotes();
  const remote = data.machineId === "local" ? undefined : data.machineId;
  const machine = remote ? (remotes.get(remote)?.name ?? "The remote") : "This computer";
  const { listings, failed, status, live, retry } = useFolder(tab.id, data, active);
  const filter = useFolderFilter(tab.id, data.filter, data.showIgnored, status.kind === "ok");
  const [mode, setMode] = useState<"files" | "search">("files");
  const [target, setTarget] = useState<{ path: string; line: number } | undefined>();
  // Folders closed while filtering; a new filter text opens them again.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setCollapsed(new Set()), [data.filter]);
  const expanded = useMemo(() => new Set(data.expanded), [data.expanded]);
  // While a new filter text is answered, the previous matches stay shown.
  const filtering = data.filter !== "" && filter.matches !== undefined;
  const rows = useMemo(
    () =>
      filtering
        ? filteredRows(filter.matches ?? [], collapsed)
        : folderRows(listings, expanded, data.selectedPath, failed),
    [filtering, filter.matches, collapsed, listings, expanded, data.selectedPath, failed],
  );
  const [copied, setCopied] = useState(false);
  const update = (patch: Partial<FolderTabData>) =>
    context.updateState({ version: 1, data: { ...data, ...patch } });

  function toggle(path: string, open: boolean) {
    if (filtering) {
      setCollapsed((current) => {
        const next = new Set(current);
        if (open) next.delete(path);
        else next.add(path);
        return next;
      });
      return;
    }
    update({
      expanded: open
        ? [...data.expanded.filter((entry) => entry !== path), path]
        : data.expanded.filter((entry) => entry !== path),
    });
  }
  async function copyPath() {
    try {
      await window.scope.copyFolderPath(tab.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="folder-tab" aria-label={`${tab.title} folder`}>
      <header className="folder-bar">
        {remote && <span className="folder-machine">{machine}</span>}
        <code className="folder-path" title={data.path}>
          {data.path}
        </code>
        <label className="folder-ignored">
          <input
            type="checkbox"
            checked={data.showIgnored}
            onChange={(event) => update({ showIgnored: event.target.checked })}
          />
          Show ignored files
        </label>
        <Button variant="ghost" size="sm" onClick={() => void copyPath()}>
          <Copy /> {copied ? "Copied" : "Copy path"}
        </Button>
      </header>
      {!live && status.kind === "ok" && (
        <p className="folder-notice" role="status">
          Live updates are slower on {remote ? machine : "this computer"}. Scope checks for changes
          every few seconds.
        </p>
      )}
      {status.kind === "ok" ? (
        <div className="folder-body">
          <div className="folder-side">
            <nav className="folder-find-modes" aria-label="Find in folder">
              <Button
                variant={mode === "files" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={mode === "files"}
                onClick={() => setMode("files")}
              >
                Files
              </Button>
              <Button
                variant={mode === "search" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={mode === "search"}
                onClick={() => setMode("search")}
              >
                Search
              </Button>
            </nav>
            <div className="folder-find" hidden={mode !== "files"}>
              <input
                className="folder-find-input"
                type="search"
                aria-label="Filter by file name"
                placeholder="Filter by file name"
                value={data.filter}
                onChange={(event) => update({ filter: event.target.value.slice(0, 1024) })}
                onKeyDown={(event) => {
                  if (event.key === "Escape") update({ filter: "" });
                }}
              />
              {data.filter && (
                <div className="folder-find-status" role="status">
                  {filterStatus(filter, remote ? machine : "this computer")}
                </div>
              )}
              <FolderTree
                tabId={tab.id}
                rows={rows}
                selected={data.selectedPath}
                onToggle={toggle}
                onSelect={(path) => {
                  setTarget(undefined);
                  update({ selectedPath: path });
                }}
                onRetry={retry}
              />
            </div>
            <div className="folder-find" hidden={mode !== "search"}>
              <FolderSearch
                tabId={tab.id}
                showIgnored={data.showIgnored}
                selected={target}
                onOpen={(path, line) => {
                  setTarget({ path, line });
                  update({ selectedPath: path });
                }}
              />
            </div>
          </div>
          {data.selectedPath ? (
            <FolderPreview
              key={data.selectedPath}
              tabId={tab.id}
              path={data.selectedPath}
              line={target?.path === data.selectedPath ? target.line : undefined}
            />
          ) : (
            <p className="folder-preview folder-state">Select a file to preview it.</p>
          )}
        </div>
      ) : (
        <Unavailable status={status} machine={machine} path={data.path} onClose={context.close} />
      )}
    </section>
  );
}
