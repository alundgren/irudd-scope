import { useState } from "react";
import { readSharingPairUrl } from "@irudd-scope/protocol/sharing";
import { activeShare } from "../sharing-contract.ts";
import { useSharing } from "./sharing-view.tsx";
import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";
import { SettingsSection } from "./settings-section.tsx";

export function SharingSettings({ query }: { query: string }) {
  const { services, error: loadError } = useSharing();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  let endpoint: string | undefined;
  try {
    endpoint = readSharingPairUrl(url).endpoint;
  } catch {
    /* Keep incomplete input editable. */
  }
  function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    void action()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not update sharing. Retry."),
      )
      .finally(() => setBusy(false));
  }
  const pair = () =>
    run(async () => {
      await window.scope.pairSharing(url);
      setUrl("");
    });
  return (
    <SettingsSection id="sharing" query={query}>
      <p className="secondary">
        Install the separate service on this Mac or a Linux VM using the standalone CLI and Docker.
      </p>
      <code>irudd-scope sharing setup</code>
      <p className="secondary">
        Paste its pairing URL here. Sharing remains off until you share a tab. A VM can keep a
        shared copy available while your Mac is off.
      </p>
      <label>
        Sharing service pairing URL
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          disabled={busy}
          placeholder="irudd-scope://pair-sharing…"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && endpoint && !busy) {
              event.preventDefault();
              pair();
            }
          }}
        />
      </label>
      {endpoint && <p className="secondary installation-path">Pair with {endpoint}</p>}
      <Button disabled={!endpoint || busy} onClick={pair}>
        {busy ? "Working…" : "Pair sharing service"}
      </Button>
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
      {!services.length && <p className="secondary">No sharing services paired.</p>}
      {services.map((service) => (
        <div key={service.id} className="installation-tool">
          <strong>{service.name}</strong>
          <p className="secondary installation-path">{service.endpoint}</p>
          <p role="status">
            {service.removing
              ? "Removal pending. Public links may still work."
              : `${service.connected ? "Connected" : "Not connected"} · ${service.shares.filter(activeShare).length} shared copies`}
          </p>
          {service.message && <p role="status">{service.message}</p>}
          <div className="installation-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => window.scope.refreshSharingStatus(service.id))}
            >
              Check connection
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => run(() => window.scope.removeSharing(service.id))}
            >
              {service.removing ? "Retry removal" : "Stop shares and remove service"}
            </Button>
          </div>
        </div>
      ))}
      <p className="secondary">
        Experimental Cloudflare Quick Tunnels can end at any time. Each service allows five shared
        copies. Links last at most 24 hours and are not restored after a service restart.
      </p>
    </SettingsSection>
  );
}
