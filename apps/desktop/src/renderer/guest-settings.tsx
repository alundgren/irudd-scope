import { operationError } from "./operation-error.ts";
import { useEffect, useState } from "react";
import type { GuestPeerStatus } from "../guest/contract.ts";
import { Button } from "./components/ui/button";

export function GuestSettings({ peerId, name }: { peerId: string; name: string }) {
  const [status, setStatus] = useState<GuestPeerStatus>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await window.scope.guestStatus();
        if (active) setStatus(value.peers.find((peer) => peer.peerId === peerId));
      } catch {
        if (active) setError("Could not read guest connection status. Retry.");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [peerId]);
  async function run(action: () => Promise<void>, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setStatus((await window.scope.guestStatus()).peers.find((peer) => peer.peerId === peerId));
      setNotice(message);
      setConsent(false);
    } catch (error) {
      setError(operationError(error, "Guest connection failed. Retry."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="guest-form">
      {status && (
        <p className="secondary" role="status">
          {status.enabled
            ? `Guest connection: ${status.state.replaceAll("-", " ")}.`
            : "Guest sharing is off."}{" "}
          {status.message}
        </p>
      )}
      {!status?.enabled && !consent && (
        <Button variant="secondary" disabled={busy || !status} onClick={() => setConsent(true)}>
          Enable guest sharing
        </Button>
      )}
      {consent && (
        <>
          <p>
            Allow {name} to access current and future eligible tabs, including hidden retained tabs,
            make changes and upload files to shared folders? Trusted HTML can run scripts. Your tabs
            and files stay on this computer.
          </p>
          <p className="secondary">Both Scopes must enable sharing.</p>
          <div className="installation-actions">
            <Button
              disabled={busy}
              onClick={() => void run(() => window.scope.setGuestAccess(peerId, true))}
            >
              Allow guest sharing
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConsent(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {status?.enabled && (
        <>
          <div className="installation-actions">
            {status.state !== "connected" && status.state !== "connecting" && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => window.scope.retryGuest(peerId))}
              >
                Retry connection
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run(() => window.scope.setGuestAccess(peerId, false))}
            >
              Disable guest sharing
            </Button>
          </div>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
