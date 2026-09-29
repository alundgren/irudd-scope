import { useEffect, useState } from "react";
import type { RemoteStatus } from "../remote-contract.ts";
import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";
import { readPairingUrl } from "@irudd-scope/protocol/remote";
import { SettingsSection } from "./settings-section.tsx";

export function RemoteSettings({ query }: { query: string }) {
  const [remotes, setRemotes] = useState<RemoteStatus[]>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  let endpoint: string | undefined;
  try {
    endpoint = readPairingUrl(url).endpoint;
  } catch {
    /* Incomplete input stays editable. */
  }
  useEffect(() => {
    const unsubscribe = window.scope.onRemotesChange(setRemotes);
    void window.scope
      .remotes()
      .then(setRemotes)
      .catch(() => setError("Could not read remotes. Close Settings and retry."));
    return unsubscribe;
  }, []);
  function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    void action()
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not update the remote. Retry."),
      )
      .finally(() => setBusy(false));
  }
  return (
    <SettingsSection id="remotes" query={query}>
      <p className="secondary">
        Run <code>irudd-scope setup</code> on the remote, then paste its pairing URL here.
      </p>
      <label>
        Pairing URL
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          disabled={busy}
          placeholder="irudd-scope://pair…"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (url.trim() && !busy)
                run(async () => {
                  await window.scope.pairRemote(url);
                  setUrl("");
                });
            }
          }}
        />
      </label>
      {endpoint && <p className="secondary installation-path">Pair with {endpoint}</p>}
      <Button
        type="button"
        disabled={!url.trim() || busy}
        onClick={() =>
          run(async () => {
            await window.scope.pairRemote(url);
            setUrl("");
          })
        }
      >
        {busy ? "Working…" : "Pair remote"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {remotes?.length === 0 && <p className="secondary">No remotes paired.</p>}
      {remotes?.map((remote) => (
        <div key={remote.id} className="installation-tool">
          <strong>{remote.name}</strong>
          <p className="secondary installation-path">{remote.endpoint}</p>
          <p role="status">{remote.message}</p>
          {remote.enabled && remote.update && (
            <p role={remote.update.phase === "error" ? "alert" : "status"}>
              {remote.update.message}
            </p>
          )}
          {remote.enabled && remote.update?.output && (
            <details className="installation-output">
              <summary>Update details</summary>
              <pre>{remote.update.output}</pre>
            </details>
          )}
          <div className="installation-actions">
            {remote.enabled && remote.update?.phase === "error" && remote.update.supported && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy || remote.connection !== "connected"}
                onClick={() => run(() => window.scope.retryRemoteUpdate(remote.id))}
              >
                Retry update
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => window.scope.setRemoteEnabled(remote.id, !remote.enabled))}
            >
              {remote.enabled ? "Disconnect" : "Connect"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => run(() => window.scope.removeRemote(remote.id))}
            >
              Remove remote
            </Button>
          </div>
        </div>
      ))}
      <p className="secondary">
        After the Mac app updates and restarts, connected remotes update their hub, CLI, and skill
        to match. Offline remotes catch up when they reconnect. An update already in progress
        finishes if you disconnect.
      </p>
      <p className="secondary">
        Enabled remotes reconnect while Scope is open. Disconnect keeps a remote off until you
        connect it again. Removal revokes its pairing.
      </p>
    </SettingsSection>
  );
}
