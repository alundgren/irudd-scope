import { useEffect, useRef, useState, type RefObject } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type {
  PublicationProvider,
  PublicationsCommand,
  PublicationsReply,
} from "@irudd-scope/protocol/publications";
import { Button } from "../renderer/components/ui/button.tsx";
import { DialogContent, DialogHeader, DialogTitle } from "../renderer/components/ui/dialog.tsx";
import { NativeSelect, NativeSelectOption } from "../renderer/components/ui/native-select.tsx";

export function PublicationDialog({
  artifact,
  open,
  finalFocus,
}: {
  artifact: Artifact;
  open: boolean;
  finalFocus: boolean | RefObject<HTMLElement | null>;
}) {
  const [provider, setProvider] = useState<PublicationProvider>("claude");
  const [reply, setReply] = useState<PublicationsReply>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<"cancel" | "unlink" | null>(null);
  const [manualRequest, setManualRequest] = useState("");
  const load = useRef(0);
  const refresh = async () => {
    const version = ++load.current;
    try {
      const result = await window.scope.publicationsCommand({ action: "read", id: artifact.id });
      if (version === load.current) {
        setReply(result);
        setError("");
      }
    } catch (failure) {
      if (version === load.current)
        setError(failure instanceof Error ? failure.message : "Could not read publication links.");
    }
  };
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setConfirmation(null);
    setManualRequest("");
    void refresh();
    const stopUpdates = window.scope.onPublicationsChanged((event) => {
      if (event.id === artifact.id) void refresh();
    });
    const stopReconnects = window.scope.onPublicationsReconnected(() => void refresh());
    return () => {
      load.current++;
      stopUpdates();
      stopReconnects();
    };
  }, [artifact.id, artifact.revision, open]);
  useEffect(() => {
    setConfirmation(null);
    setCopied(false);
    setManualRequest("");
  }, [provider]);
  const snapshot = reply?.snapshot;
  const destination = snapshot?.destinations.find((entry) => entry.provider === provider);
  const operation = destination?.operation;
  const checkpoint = destination?.checkpoint;
  const remoteUrl =
    operation?.progress?.url ?? operation?.observation.url ?? checkpoint?.result.url;
  const label = provider === "claude" ? "Claude artifact" : "OpenAI Site";
  const request = [
    `Publish Scope artifact ${JSON.stringify(artifact.id)} to ${label}.`,
    "Use the irudd-scope skill's outbound-publications reference and publications guide.",
    `Read the current snapshot. ${operation ? `Resume operation ${operation.operationId} for revision ${operation.revision}; reconcile any started provider write before retrying.` : "Prepare the current stored HTML revision."}`,
    "Check actual native tool availability, authenticated account and audience, and fresh remote edit metadata. Stop if privacy cannot be verified. Refresh the same operation before starting; changed remote facts require a new warning and acknowledgement.",
    "Preserve the exported bytes and provider version guards. Wait for confirmed publication before completing the Scope checkpoint. Never pull, force a conflict, change sharing, or automatically retry an uncertain remote write.",
  ].join("\n");
  const run = async (command: PublicationsCommand) => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      await window.scope.publicationsCommand(command);
      await refresh();
      setConfirmation(null);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Publication action failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const write = (action: "authorize" | "cancel") => {
    if (!snapshot || !operation) return;
    const address = {
      id: artifact.id,
      tabId: snapshot.tabId,
      provider,
      operationId: operation.operationId,
    };
    void run(
      action === "authorize"
        ? { ...address, action, expectedObservation: operation.observation }
        : { ...address, action, acknowledgeUncertain: operation.state === "started" },
    );
  };
  const unlink = () => {
    if (!snapshot) return;
    void run({
      action: "unlink",
      id: artifact.id,
      tabId: snapshot.tabId,
      provider,
      acknowledgeUncertain: operation?.state === "started",
    });
  };
  return (
    <DialogContent
      finalFocus={finalFocus}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
    >
      <DialogHeader>
        <DialogTitle className="pr-8">Publish with coding agent</DialogTitle>
        <p className="break-words text-muted-foreground">{artifact.title}</p>
      </DialogHeader>
      <label className="grid gap-2">
        <span>Destination</span>
        <NativeSelect
          value={provider}
          onChange={(event) => setProvider(event.target.value as PublicationProvider)}
          disabled={busy}
        >
          <NativeSelectOption value="claude">Claude artifact</NativeSelectOption>
          <NativeSelectOption value="sites">OpenAI Site</NativeSelectOption>
        </NativeSelect>
      </label>
      <p className="text-muted-foreground">
        Your current coding session publishes the HTML. Copy the request and paste it into that
        session.
      </p>
      <p className="text-muted-foreground">
        {provider === "claude"
          ? "Updates need a signed-in Claude session with artifact tools and access to its sharing settings."
          : "Sites tools must be available in your session. Only owner-private Sites are supported."}
      </p>
      {!reply && !error && <p role="status">Loading publication links...</p>}
      {error && (
        <div role="alert" className="grid gap-2">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
            Retry
          </Button>
        </div>
      )}
      {snapshot && (
        <>
          {checkpoint ? (
            <p>
              {checkpoint.revision === snapshot.artifact.revision
                ? `Revision ${checkpoint.revision} published.`
                : `Revision ${checkpoint.revision} published. Revision ${snapshot.artifact.revision} has unpublished changes.`}
            </p>
          ) : (
            <p>No successful publication recorded.</p>
          )}
          {remoteUrl && (
            <a
              className="break-all text-primary underline"
              href={remoteUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open {label}
            </a>
          )}
          {(operation?.observation ?? checkpoint?.observation) && (
            <p className="text-muted-foreground">
              Last checked{" "}
              {new Date(
                (operation?.observation ?? checkpoint!.observation).checkedAt,
              ).toLocaleString()}
              . Access can change after this check.
            </p>
          )}
          {operation?.needsRefresh && (
            <p role="status" className="text-muted-foreground">
              Recheck before publishing. Your agent must refresh the remote facts.
            </p>
          )}
          {operation && (
            <div
              className="grid gap-2"
              role={
                operation.state === "warning" || operation.state === "blocked" ? "alert" : "status"
              }
            >
              {operation.state === "blocked" ? (
                <>
                  <p>Cannot publish to this destination.</p>
                  <ul className="list-disc space-y-2 pl-5">
                    {operation.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  <p>
                    Ask your agent to verify the destination again. Privacy checks cannot be
                    overridden.
                  </p>
                </>
              ) : operation.state === "warning" ? (
                <>
                  <p>Publishing may overwrite remote edits.</p>
                  <ul className="list-disc space-y-2 pl-5">
                    {operation.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  <p>
                    Allow replacement of the remote content with Scope revision {operation.revision}
                    ?
                  </p>
                  <Button variant="destructive" disabled={busy} onClick={() => write("authorize")}>
                    Allow replacement
                  </Button>
                </>
              ) : (
                <p>
                  {operation.state === "started"
                    ? "Publication started. Ask your agent to check the provider result before retrying."
                    : `Revision ${operation.revision} is prepared. Copy the request to continue.`}
                </p>
              )}
              {operation.state !== "warning" &&
                operation.state !== "blocked" &&
                operation.warnings.length > 0 && (
                  <p className="text-muted-foreground">
                    Replacement acknowledged for this operation. New remote edits require another
                    check.
                  </p>
                )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || operation?.state === "warning"}
              onClick={() => {
                void navigator.clipboard.writeText(request).then(
                  () => {
                    setCopied(true);
                    setManualRequest("");
                  },
                  () => {
                    setError("Clipboard is unavailable. Copy the request below.");
                    setManualRequest(request);
                  },
                );
              }}
            >
              {copied ? "Copied" : "Copy request"}
            </Button>
            {operation && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  operation.state === "started" ? setConfirmation("cancel") : write("cancel")
                }
              >
                Cancel preparation
              </Button>
            )}
            {(checkpoint || operation?.progress) && (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmation("unlink")}>
                Unlink
              </Button>
            )}
          </div>
          {copied && (
            <p role="status" className="text-muted-foreground">
              Paste into your coding session.
            </p>
          )}
          {manualRequest && (
            <textarea
              className="min-h-32 w-full rounded-lg border border-input bg-background p-2"
              aria-label="Agent publication request"
              readOnly
              value={manualRequest}
              onFocus={(event) => event.target.select()}
            />
          )}
          {confirmation && (
            <div className="grid gap-2" role="alert">
              <p>
                {confirmation === "unlink"
                  ? "Remove Scope's saved link and checkpoint? The remote artifact stays intact."
                  : "Cancel Scope's recovery record? The provider may already have published. Ask your agent to reconcile the result first."}
              </p>
              {operation?.state === "started" && confirmation === "unlink" && (
                <p>
                  The provider result is unresolved. A later request may create another remote
                  artifact.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => (confirmation === "unlink" ? unlink() : write("cancel"))}
                >
                  {confirmation === "unlink" ? "Remove saved link" : "Cancel record anyway"}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
                  Keep record
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </DialogContent>
  );
}
