import { useEffect, useState } from "react";
import type { AgentToolStatus, UpdateStatus } from "../installation-contract.ts";
import { Button } from "./components/ui/button.tsx";
import { AgentToolSettings } from "./agent-tool-settings.tsx";
import { SigningSettings } from "./signing-settings.tsx";
import { SettingsSection } from "./settings-section.tsx";

function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    const unsubscribe = window.scope.onUpdatesChange(setStatus);
    void window.scope
      .updates()
      .then(setStatus)
      .catch(() =>
        setStatus({
          phase: "error",
          message: "Could not read update status. Close Settings and try again.",
        }),
      );
    return unsubscribe;
  }, []);
  return status;
}

export function UpdateNotice() {
  const status = useUpdates();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (status?.phase !== "ready") return null;
  return (
    <div className="connection-notice" role="status">
      <span>{error || status.message}</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void window.scope
            .restartToUpdate()
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Could not restart. Try again.");
            })
            .finally(() => setBusy(false));
        }}
      >
        {status.operation === "signing" ? "Restart to apply" : "Restart to update"}
      </Button>
    </div>
  );
}

function BuildProgress({
  status,
  disabled,
  onRestart,
  onCancel,
  onCheck,
}: {
  status: UpdateStatus | undefined;
  disabled: boolean;
  onRestart: () => void;
  onCancel: () => void;
  onCheck?: () => void;
}) {
  const { phase, operation, message, nextSigningCertificate, output } = status ?? {};
  const busy = phase === "checking" || phase === "building";
  const signing = operation === "signing";
  return (
    <>
      <p role="status">{message ?? "Reading update status…"}</p>
      {signing && (phase === "building" || phase === "ready") && (
        <p className="secondary">
          After restart: {nextSigningCertificate?.name ?? "default signing without a certificate"}.
        </p>
      )}
      <div className="installation-actions">
        {phase === "ready" ? (
          <Button type="button" disabled={disabled} onClick={onRestart}>
            {signing ? "Restart to apply" : "Restart to update"}
          </Button>
        ) : onCheck ? (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || !status || busy}
            onClick={onCheck}
          >
            {busy
              ? "Updating…"
              : phase === "error" && !signing
                ? "Retry update"
                : "Check for updates"}
          </Button>
        ) : null}
        {(busy || (signing && phase === "ready")) && (
          <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
            {signing ? "Cancel change" : "Cancel update"}
          </Button>
        )}
      </div>
      {output && (
        <details className="installation-output" open={phase === "error"}>
          <summary>{phase === "error" ? "Error details" : "Build output"}</summary>
          <pre>{output}</pre>
        </details>
      )}
    </>
  );
}

export function InstallationSettings({ query }: { query: string }) {
  const updates = useUpdates();
  const [tools, setTools] = useState<AgentToolStatus>();
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    const unsubscribe = window.scope.onAgentToolsChange(setTools);
    void window.scope
      .agentTools()
      .then(setTools)
      .catch(() => setError("Could not read installation status. Close Settings and try again."));
    return unsubscribe;
  }, []);
  const phase = updates?.phase;
  const toolsBusy = Boolean(tools?.busy);
  const updating = phase === "checking" || phase === "building";
  const disabled = !tools?.available || toolsBusy || updating || restarting;
  function run(action: () => Promise<unknown>) {
    setError("");
    void action().catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Could not complete the operation. Try again.",
      ),
    );
  }
  const progress = (
    <BuildProgress
      status={updates}
      disabled={restarting || toolsBusy}
      onRestart={() => {
        setRestarting(true);
        run(() => window.scope.restartToUpdate().finally(() => setRestarting(false)));
      }}
      onCancel={() => run(() => window.scope.cancelUpdate())}
      onCheck={() => run(() => window.scope.checkForUpdates())}
    />
  );
  return (
    <>
      <SettingsSection id="updates" query={query}>
        {phase === "unmanaged" && <p>{updates?.message}</p>}
        {phase !== "unmanaged" && (
          <>
            <p className="secondary">
              Scope checks main on startup and builds new commits on this Mac. Your work stays open
              until you restart.
            </p>
            {updates?.currentCommit && (
              <p className="secondary">
                Installed commit <code>{updates.currentCommit.slice(0, 8)}</code>
              </p>
            )}
            {progress}
          </>
        )}
      </SettingsSection>
      <AgentToolSettings query={query} tools={tools} disabled={disabled} run={run} />
      <SettingsSection id="signing" query={query}>
        <SigningSettings
          status={updates}
          disabled={updating || restarting || toolsBusy}
          progress={updates?.operation === "signing" || updating ? progress : null}
        />
      </SettingsSection>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
