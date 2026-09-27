import { useEffect, useState } from "react";
import type { AgentToolStatus, UpdateStatus } from "../installation-contract.ts";
import { Button } from "./components/ui/button.tsx";

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
      <span>{error || "A Scope update is ready."}</span>
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
        Restart to update
      </Button>
    </div>
  );
}

export function InstallationSettings({
  showUpdates,
  showTools,
}: {
  showUpdates: boolean;
  showTools: boolean;
}) {
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
  const updating = updates?.phase === "checking" || updates?.phase === "building";
  const disabled = !tools?.available || Boolean(tools.busy) || updating || restarting;
  function run(action: () => Promise<unknown>) {
    setError("");
    void action().catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Could not complete the operation. Try again.",
      ),
    );
  }
  return (
    <>
      <fieldset hidden={!showUpdates}>
        <legend>App updates</legend>
        <p role="status">{updates?.message ?? "Reading update status…"}</p>
        {updates?.phase !== "unmanaged" && (
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
            <div className="installation-actions">
              {updates?.phase === "ready" ? (
                <Button
                  type="button"
                  disabled={restarting || Boolean(tools?.busy)}
                  onClick={() => {
                    setRestarting(true);
                    run(() => window.scope.restartToUpdate().finally(() => setRestarting(false)));
                  }}
                >
                  Restart to update
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!updates || updating || Boolean(tools?.busy)}
                  onClick={() => run(() => window.scope.checkForUpdates())}
                >
                  {updating
                    ? "Updating…"
                    : updates?.phase === "error"
                      ? "Retry update"
                      : "Check for updates"}
                </Button>
              )}
              {updating && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => run(() => window.scope.cancelUpdate())}
                >
                  Cancel update
                </Button>
              )}
            </div>
            {updates?.output && (
              <details className="installation-output">
                <summary>{updates.phase === "error" ? "Error details" : "Build output"}</summary>
                <pre>{updates.output}</pre>
              </details>
            )}
          </>
        )}
      </fieldset>
      <fieldset hidden={!showTools}>
        <legend>Agent tools</legend>
        {!tools?.available && (
          <p className="secondary">Use the installed Mac app to install agent tools.</p>
        )}
        <div className="installation-tool">
          <div>
            <h3>Scope CLI</h3>
            <p className="secondary">
              Publish artifacts with <code>irudd-scope</code>. The CLI updates with the app.
            </p>
          </div>
          <div className="installation-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => run(() => window.scope.installCli())}
            >
              {tools?.busy === "cli"
                ? "Working…"
                : tools?.cliInstalled
                  ? "Repair CLI"
                  : "Install CLI"}
            </Button>
            {tools?.cliInstalled && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => run(() => window.scope.removeCli())}
              >
                Remove CLI
              </Button>
            )}
          </div>
          {tools?.cliInstalled && (
            <p className="secondary installation-path">
              Installed at <code>{tools.cliPath}</code>
            </p>
          )}
        </div>
        <div className="installation-tool">
          <div>
            <h3>Scope skill</h3>
            <p className="secondary">
              Install publishing instructions globally for Codex and Claude Code with npx skills.
            </p>
          </div>
          <div className="installation-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => run(() => window.scope.installSkill())}
            >
              {tools?.busy === "skill"
                ? "Working…"
                : tools?.skillInstalled
                  ? "Update skill"
                  : "Install skill"}
            </Button>
            {tools?.skillInstalled && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => run(() => window.scope.removeSkill())}
              >
                Remove skill
              </Button>
            )}
          </div>
          {tools?.skillInstalled && <p className="secondary">Installed globally</p>}
        </div>
        {tools?.message && <p role="status">{tools.message}</p>}
        {tools?.error && (
          <details className="installation-output" open>
            <summary role="alert">Installation failed. Try again.</summary>
            <pre>{tools.error}</pre>
          </details>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
