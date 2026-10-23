import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useRemotes } from "../../renderer/remote-names.ts";
import type { TabContext } from "../api.ts";
import type { Tab } from "../../workspace/contract.ts";
import { FolderTabState, type FolderTabData } from "./contract.ts";
import { useFolder, type FolderStatus } from "./use-folder.ts";
import { FolderTree, folderRows } from "./tree.tsx";

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
  const expanded = useMemo(() => new Set(data.expanded), [data.expanded]);
  const rows = useMemo(
    () => folderRows(listings, expanded, data.selectedPath, failed),
    [listings, expanded, data.selectedPath, failed],
  );
  const [copied, setCopied] = useState(false);
  const update = (patch: Partial<FolderTabData>) =>
    context.updateState({ version: 1, data: { ...data, ...patch } });

  function toggle(path: string, open: boolean) {
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
        <FolderTree
          tabId={tab.id}
          rows={rows}
          selected={data.selectedPath}
          onToggle={toggle}
          onSelect={(path) => update({ selectedPath: path })}
          onRetry={retry}
        />
      ) : (
        <Unavailable status={status} machine={machine} path={data.path} onClose={context.close} />
      )}
    </section>
  );
}
