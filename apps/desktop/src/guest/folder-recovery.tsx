import { useCallback, useEffect, useState } from "react";
import { operationError } from "../renderer/operation-error.ts";
import { Button } from "../renderer/components/ui/button.tsx";
import type { GuestFolderRecoveryView } from "./folder-recovery-contract.ts";

export function GuestFolderRecovery({ tabId }: { tabId: string }) {
  const [pending, setPending] = useState<GuestFolderRecoveryView>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    try {
      setPending(await window.scope.guestFolderRecovery(tabId));
      setMessage("");
    } catch {
      setMessage("Could not read saved upload input. Retry recovery.");
    }
  }, [tabId]);
  useEffect(() => {
    void refresh();
    return window.scope.onGuestRecoveryChanged((id) => {
      if (id === tabId) void refresh();
    });
  }, [tabId, refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(operationError(error));
    } finally {
      setBusy(false);
    }
  };
  if (!pending && !message) return null;
  const state = pending?.outcome?.state;
  const uncertain = !state || ["unknown", "unresolved", "expired"].includes(state);
  return (
    <div className="folder-transfers guest-folder-recovery" aria-label="Folder upload recovery">
      {pending && (
        <>
          <p role="status">
            {pending.write.operation.path}:{" "}
            {uncertain
              ? "Outcome unknown. Nothing will be retried automatically."
              : state === "pending"
                ? "The host is still processing this operation."
                : state === "failed"
                  ? `The host rejected this operation. ${pending.outcome?.error?.error ?? ""}`
                  : "The host recorded this operation as completed."}
          </p>
          {pending.original && (
            <p>
              Original file: <code>{pending.original.path}</code>{" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void run(() => window.scope.guestFolderCopyOriginal(tabId))}
              >
                Copy original path
              </Button>
            </p>
          )}
          <div className="folder-bar">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => window.scope.guestFolderStatus(tabId))}
            >
              {busy ? "Checking…" : "Check upload status"}
            </Button>
            {!pending.active && state && state !== "pending" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    window.scope.guestFolderRelease({
                      tabId,
                      requestId: pending.write.operation.requestId,
                      ...(uncertain ? { acknowledgedOutcome: pending.outcome } : {}),
                    }),
                  )
                }
              >
                {uncertain
                  ? "I checked the destination; clear recovery"
                  : "Refresh folder and clear recovery"}
              </Button>
            )}
          </div>
          {pending.active && (
            <p>This request is still running. Recovery can be cleared after it stops.</p>
          )}
          {uncertain && (
            <p>
              Inspect the destination before clearing recovery. The original file stays on this
              computer. A new upload requires a new explicit action.
            </p>
          )}
        </>
      )}
      {message && (
        <p role="alert">
          {message}{" "}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
            Retry recovery
          </Button>
        </p>
      )}
    </div>
  );
}
