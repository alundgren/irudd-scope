import { operationError } from "./operation-error.ts";
import { useEffect, useState } from "react";
import type { GuestDevices, GuestPairingStatus } from "../guest/contract.ts";
import { GuestSettings } from "./guest-settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export function GuestPairingSettings() {
  const [devices, setDevices] = useState<GuestDevices>();
  const [pairing, setPairing] = useState<GuestPairingStatus>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forget, setForget] = useState<string>();
  useEffect(() => {
    let active = true;
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const [devices, pairing] = await Promise.all([
          window.scope.guestDevices(),
          window.scope.guestPairingStatus(),
        ]);
        if (!active) return;
        setDevices(devices);
        setName((name) => name || devices.name);
        setPairing(pairing);
      } catch (error) {
        if (active) setError(operationError(error, "Guest pairing failed. Retry."));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function run(action: () => Promise<unknown>, notice = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setPairing(await window.scope.guestPairingStatus());
      setDevices(await window.scope.guestDevices());
      setNotice(notice);
    } catch (error) {
      const status = await window.scope.guestPairingStatus().catch(() => undefined);
      if (status) setPairing(status);
      const message = operationError(error, "Guest pairing failed. Retry.");
      setError(
        status?.state === "revocation-failed" ||
          (status?.state === "failed" && status.message === message)
          ? ""
          : message,
      );
    } finally {
      setBusy(false);
    }
  }
  const ended = !pairing || ["complete", "expired", "cancelled", "failed"].includes(pairing.state);
  return (
    <div className="guest-form min-w-0">
      <p>Share tabs with another Scope over your Tailscale network. Both apps must be open.</p>
      {devices?.credentialStorage === "session" && (
        <p className="secondary">Pairing on this device lasts until this app closes.</p>
      )}
      {ended && (
        <>
          <label>
            This Scope's guest name
            <Input
              value={name}
              maxLength={160}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="installation-actions">
            <Button
              disabled={busy || !name.trim()}
              onClick={() => void run(() => window.scope.createGuestInvitation(name.trim()))}
            >
              Create guest invitation
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !name.trim()}
              onClick={() => void run(() => window.scope.inspectGuestInvitation(name.trim()))}
            >
              Paste guest invitation
            </Button>
          </div>
        </>
      )}
      {pairing && (
        <div className="guest-form" aria-label="Guest pairing">
          {pairing.state === "waiting" && (
            <>
              <p>
                Copy the invitation to the other Scope. It expires after five minutes and pairs one
                device.
              </p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => window.scope.copyGuestInvitation(pairing.id),
                    "Guest invitation copied. Paste it in Other Scopes on the other device.",
                  )
                }
              >
                Copy guest invitation
              </Button>
            </>
          )}
          {pairing.state === "review" && (
            <>
              <p className="break-words">
                Allow guest sharing with <strong>{pairing.peerName}</strong>?
              </p>
              <p>
                That Scope can read current and future eligible tabs, including hidden retained
                tabs, make changes and upload files to shared folders. Trusted HTML can run scripts.
                Your tabs and files stay on this computer.
              </p>
              <p className="secondary">
                Both people must approve. Only share an invitation with the person you intend to
                pair.
              </p>
              <Button
                aria-label={"Allow guest sharing with " + pairing.peerName}
                disabled={busy}
                onClick={() => void run(() => window.scope.approveGuestPairing(pairing.id))}
              >
                Allow guest sharing
              </Button>
            </>
          )}
          {pairing.state === "pending" && (
            <p role="status">Waiting for {pairing.peerName} to approve and finish pairing…</p>
          )}
          {pairing.state === "saving" && (
            <p role="status">Protecting the pair and verifying both connections…</p>
          )}
          {pairing.state === "complete" && (
            <p role="status">Guest sharing paired with {pairing.peerName}.</p>
          )}
          {pairing.state === "expired" && (
            <p role="status">Guest invitation expired. Create or paste a new invitation.</p>
          )}
          {pairing.state === "cancelled" && <p role="status">Guest pairing cancelled.</p>}
          {pairing.state === "cancelling" && (
            <p role="status">Stopping guest sharing and saving cancellation…</p>
          )}
          {pairing.state === "revocation-failed" && <p role="alert">{pairing.message}</p>}
          {pairing.state === "failed" && (
            <p role="alert">
              {pairing.message}{" "}
              {devices?.peers.some((peer) => peer.id === pairing.id)
                ? "Pairing is incomplete. Forget the incomplete pair below, then create a new invitation."
                : "Create or paste a new invitation to retry."}
            </p>
          )}
          {!ended && pairing.state !== "cancelling" && (
            <Button
              variant="secondary"
              onClick={() => void run(() => window.scope.cancelGuestPairing(pairing.id))}
            >
              {pairing.state === "revocation-failed"
                ? "Retry cancellation"
                : "Cancel guest pairing"}
            </Button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {devices?.peers.length === 0 && <p className="secondary">No guest Scopes paired.</p>}
      {devices?.peers.map((peer) => (
        <div className="installation-tool" key={peer.id}>
          <strong className="break-words">{peer.name}</strong>
          {pairing?.id === peer.id && pairing.state !== "complete" ? (
            <p className="secondary">
              {pairing.state === "cancelling" || pairing.state === "revocation-failed"
                ? "Finish cancellation above before forgetting this incomplete pair."
                : "This pair is incomplete. Forget it before pairing again."}
            </p>
          ) : (
            <GuestSettings peerId={peer.id} name={peer.name} />
          )}
          {forget === peer.id ? (
            <>
              <p>
                Forget {peer.name}? Guest access stops. Pair again to reconnect; saved guest
                references and recovery input stay here.
              </p>
              <div className="installation-actions">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.scope.forgetGuest(peer.id);
                      setForget(undefined);
                    })
                  }
                >
                  Forget guest Scope
                </Button>
                <Button variant="secondary" onClick={() => setForget(undefined)}>
                  Keep paired
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant="secondary"
              disabled={busy}
              aria-label={"Forget guest " + peer.name}
              onClick={() => setForget(peer.id)}
            >
              Forget guest Scope
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
