import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useRemotes } from "../../renderer/remote-names.ts";
import { operationError } from "../../renderer/operation-error.ts";
import type { TabContext } from "../api.ts";
import type { Tab } from "../../workspace/contract.ts";
import { FolderTabState, folderTabState, folderAncestors, type FolderTabData } from "./contract.ts";
import { useFolder, type FolderStatus } from "./use-folder.ts";
import { FolderTree, filteredRows, folderRows } from "./tree.tsx";
import { FolderSearch, filterStatus, useFolderFilter } from "./find-panel.tsx";
import { FolderPreview } from "./preview.tsx";
import { ClashQuestion, FolderTransfers, useFolderDrop } from "./transfers.tsx";

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
  const guest = tab.type === "guest";
  const data = decode(
    FolderTabState,
    guest
      ? {
          version: 1,
          data: {
            ...folderTabState({ machineId: "local", path: "/" }).data,
            ...(tab.state.data.folder as object),
          },
        }
      : tab.state,
  ).data;
  const [ownerMachine, setOwnerMachine] = useState("Owner computer");
  useEffect(() => {
    if (!guest || !active) return;
    let cancelled = false;
    void window.scope.guestFolderInfo(tab.id).then(
      (info) => {
        if (!cancelled) setOwnerMachine(info.machine);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [guest, active, tab.id]);
  const updateReading = (next: FolderTabData) => {
    if (!guest) context.updateState({ version: 1, data: next });
    else {
      const { machineId: _machine, path: _path, ...reading } = next;
      context.updateState({ version: 1, data: { ...tab.state.data, folder: reading } });
    }
  };
  const [directory, setDirectory] = useState<string | undefined>();
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const remotes = useRemotes();
  const remote = data.machineId === "local" ? undefined : data.machineId;
  const machine = guest
    ? `${context.content?.ownerName ?? "Owner"} · ${ownerMachine}`
    : remote
      ? (remotes.get(remote)?.name ?? "The remote")
      : "This computer";
  const { listings, failed, status, live, load, retry } = useFolder(tab.id, data, active);
  const filter = useFolderFilter(tab.id, data.filter, data.showIgnored, status.kind === "ok");
  const [mode, setMode] = useState<"files" | "search">("files");
  const [target, setTarget] = useState<{ path: string; line: number } | undefined>();
  // Folders closed while filtering; a new filter text opens them again.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setCollapsed(new Set()), [data.filter]);
  const expanded = useMemo(() => new Set(data.expanded), [data.expanded]);
  // A file selected by an agent, a drop, or a search match, rather than in the tree, is
  // revealed: its folders open in the tree shown, and if the filter would hide it the tree
  // shows every file until the person edits the filter or chooses Filter again. The filter
  // text stays. A tab opened after restart reveals its saved selection, which an agent may
  // have made while the tab was not shown.
  const [reveal, setReveal] = useState(data.selectedPath);
  const [paused, setPaused] = useState(false);
  const [revealCount, setRevealCount] = useState(0);
  const filterInput = useRef<HTMLInputElement>(null);
  if (reveal !== null && data.filter === "") setReveal(null);
  else if (reveal !== null && filter.text === data.filter && filter.matches !== undefined) {
    setReveal(null);
    if (!filter.matches.some((match) => match.path === reveal)) setPaused(true);
  }
  const revealFile = useCallback((path: string) => {
    setReveal(path);
    setRevealCount((count) => count + 1);
    const above = folderAncestors(path);
    setCollapsed((current) =>
      above.some((folder) => current.has(folder))
        ? new Set([...current].filter((folder) => !above.includes(folder)))
        : current,
    );
  }, []);
  // The workspace applies the agent's selection to the tab state; a repeated selection of
  // the same file changes nothing there but is still revealed.
  useEffect(
    () =>
      window.scope.onFolderTabOpened(({ tab: opened, selected }) => {
        if (opened.id !== tab.id || !selected) return;
        setTarget(undefined);
        revealFile(selected.file);
      }),
    [tab.id, revealFile],
  );
  const resumeFilter = (focus: boolean) => {
    setReveal(null);
    setPaused(false);
    if (focus) filterInput.current?.focus();
  };
  // While a new filter text is answered, the previous matches stay shown.
  const filtering = data.filter !== "" && filter.matches !== undefined && !paused;
  const selectedName = data.selectedPath?.slice(data.selectedPath.lastIndexOf("/") + 1);
  const rows = useMemo(
    () =>
      filtering
        ? filteredRows(filter.matches ?? [], collapsed)
        : folderRows(listings, expanded, data.selectedPath, failed),
    [filtering, filter.matches, collapsed, listings, expanded, data.selectedPath, failed],
  );
  const [copied, setCopied] = useState(false);
  const update = (patch: Partial<FolderTabData>) => updateReading({ ...data, ...patch });
  /** Selects a file from outside the tree, opening its folders, and reveals it. */
  const selectAndReveal = (path: string, current: FolderTabData) => {
    updateReading({
      ...current,
      expanded: [...new Set([...current.expanded, ...folderAncestors(path)])],
      selectedPath: path,
      selectedLines: null,
    });
    revealFile(path);
  };
  const latest = useRef(data);
  latest.current = data;
  // The tree shows dropped files and selects the first one, opening its folders. Their
  // folders are read now, as the change feed reports the files only after its next batch.
  const dropping = useFolderDrop(tab.id, (paths) => {
    const first = paths[0]!;
    const current = latest.current;
    void load(new Set(paths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/"))))));
    selectAndReveal(first, current);
  });

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
    <section
      className="folder-tab"
      data-guest={guest || undefined}
      aria-label={`${tab.title} folder`}
    >
      <header className="folder-bar">
        {(remote || guest) && <span className="folder-machine">{machine}</span>}
        <code className="folder-path" title={guest ? tab.title : data.path}>
          {guest ? tab.title : data.path}
        </code>
        <label className="folder-ignored">
          <input
            type="checkbox"
            checked={data.showIgnored}
            onChange={(event) => update({ showIgnored: event.target.checked })}
          />
          Show ignored files
        </label>
        {guest && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDirectory("");
              setDirectoryError("");
            }}
          >
            New folder
          </Button>
        )}
        {!guest && (
          <Button variant="ghost" size="sm" onClick={() => void copyPath()}>
            <Copy /> {copied ? "Copied" : "Copy path"}
          </Button>
        )}
      </header>
      {guest && directory !== undefined && (
        <form
          className="folder-bar"
          onSubmit={(event) => {
            event.preventDefault();
            setDirectoryBusy(true);
            setDirectoryError("");
            void window.scope
              .createFolderDirectory({ tabId: tab.id, path: directory })
              .then(
                () => {
                  setDirectory(undefined);
                  void load([""]);
                },
                (error) => setDirectoryError(operationError(error)),
              )
              .finally(() => setDirectoryBusy(false));
          }}
        >
          <input
            className="folder-find-input"
            aria-label="New folder path"
            placeholder="Folder name or relative path"
            value={directory}
            disabled={directoryBusy}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={directoryBusy || !directory}>
            Create
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={directoryBusy}
            onClick={() => setDirectory(undefined)}
          >
            Cancel
          </Button>
          {directoryError && <p role="alert">{directoryError}</p>}
        </form>
      )}
      {!live && status.kind === "ok" && (
        <p className="folder-notice" role="status">
          Live updates are slower on {remote || guest ? machine : "this computer"}. Scope checks for
          changes every few seconds.
        </p>
      )}
      <FolderTransfers
        tabId={tab.id}
        notice={dropping.notice}
        onDismissNotice={dropping.dismissNotice}
      />
      <ClashQuestion question={dropping.question} />
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
                ref={filterInput}
                value={data.filter}
                onChange={(event) => {
                  resumeFilter(false);
                  update({ filter: event.target.value.slice(0, 1024) });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  resumeFilter(false);
                  update({ filter: "" });
                }}
              />
              {data.filter && (
                <div className="folder-find-status" role="status">
                  {paused ? (
                    <>
                      <span>
                        {selectedName
                          ? `Showing all files so ${selectedName} is visible.`
                          : "Showing all files."}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => resumeFilter(true)}>
                        Filter again
                      </Button>
                    </>
                  ) : (
                    filterStatus(filter, remote ? machine : "this computer")
                  )}
                </div>
              )}
              <FolderTree
                tabId={tab.id}
                rows={rows}
                selected={data.selectedPath}
                revealCount={revealCount}
                onToggle={toggle}
                onSelect={(path) => {
                  setTarget(undefined);
                  update({ selectedPath: path, selectedLines: null });
                }}
                onRetry={retry}
                onDropFiles={(folder, files) => void dropping.drop(folder, files)}
              />
            </div>
            <div className="folder-find" hidden={mode !== "search"}>
              <FolderSearch
                tabId={tab.id}
                showIgnored={data.showIgnored}
                selected={target}
                onOpen={(path, line) => {
                  setTarget({ path, line });
                  selectAndReveal(path, data);
                }}
              />
            </div>
          </div>
          {data.selectedPath ? (
            <FolderPreview
              key={data.selectedPath}
              tabId={tab.id}
              path={data.selectedPath}
              lines={
                target?.path === data.selectedPath
                  ? { start: target.line, end: target.line }
                  : (data.selectedLines ?? undefined)
              }
            />
          ) : (
            <p className="folder-preview folder-state">Select a file to preview it.</p>
          )}
        </div>
      ) : (
        <Unavailable
          status={status}
          machine={machine}
          path={guest ? tab.title : data.path}
          onClose={context.close}
        />
      )}
    </section>
  );
}
