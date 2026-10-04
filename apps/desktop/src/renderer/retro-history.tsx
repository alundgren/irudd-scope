import { useContext, useEffect, useState } from "react";
import type { RetroReply } from "@irudd-scope/protocol/retro";
import { WorkspaceNavigationContext } from "../workspace/navigation-context.ts";
import { Button } from "./components/ui/button.tsx";
import { retroError } from "./retro-error.ts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type History = Extract<RetroReply, { type: "history" }>;
export function RetroHistory({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigation = useContext(WorkspaceNavigationContext);
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(after?: string) {
    setBusy(true);
    setError("");
    try {
      const reply = await window.scope.retroCommand({
        action: "history",
        ...(after ? { after } : {}),
      });
      if (reply.type !== "history") throw new Error("Could not read retrospective history.");
      setHistory((previous) => ({
        ...reply,
        entries: after ? [...(previous?.entries ?? []), ...reply.entries] : reply.entries,
      }));
    } catch (failure) {
      setError(retroError(failure, "Could not read retrospective history."));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open]);
  async function reopen(tabId: string) {
    setBusy(true);
    setError("");
    try {
      if (!navigation) throw new Error("Open this report from the workspace.");
      await navigation.openSavedTab(tabId);
      onOpenChange(false);
    } catch (failure) {
      setError(retroError(failure, "Could not open this report."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="retro-history-dialog">
        <DialogHeader>
          <DialogTitle>Retrospective history</DialogTitle>
        </DialogHeader>
        <p className="secondary">Saved final reports. Opening a report does not start an agent.</p>
        {error && (
          <div role="alert">
            <p>{error}</p>
            <Button variant="secondary" disabled={busy} onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
        {!history && !error && <p role="status">Loading reports…</p>}
        {history?.entries.length === 0 && (
          <p className="empty-state" role="status">
            No completed retros yet. Ask your coding agent for a Scope retro.
          </p>
        )}
        <div className="retro-history-list">
          {history?.entries.map((entry) => (
            <div className="retro-history-row" key={entry.tabId}>
              <div>
                <strong>{entry.artifact.title}</strong>
                <p className="secondary">
                  {new Date(entry.finishedAt).toLocaleDateString()} · {entry.reviewedSessions}{" "}
                  reviewed sessions
                </p>
                <p>{entry.summary}</p>
              </div>
              <Button variant="secondary" disabled={busy} onClick={() => void reopen(entry.tabId)}>
                Open report
              </Button>
            </div>
          ))}
        </div>
        {history?.next && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void load(history.next ?? undefined)}
          >
            More reports
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
