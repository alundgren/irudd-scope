import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export type Invitation = Awaited<ReturnType<typeof window.scope.transferStatus>>;

export function transferError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : "Could not complete the transfer. Retry.";
}

export function useInvitationStatus(
  invitation: Invitation | undefined,
  onStatus: (value: Invitation) => void,
  onError: (error: string) => void,
) {
  useEffect(() => {
    if (!invitation || !["waiting", "importing"].includes(invitation.state)) return;
    let active = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void window.scope
        .transferStatus(invitation.id)
        .then((value) => {
          if (active) onStatus(value);
        })
        .catch((error: unknown) => {
          if (active) onError(transferError(error));
        })
        .finally(() => {
          pending = false;
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [invitation?.id, invitation?.state]);
}

export function TransferInvitation({
  invitation,
  pairing = false,
  onError,
}: {
  invitation: Invitation;
  pairing?: boolean;
  onError: (error: string) => void;
}) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    setQr("");
    setCopied("");
    void QRCode.toDataURL(invitation.url, { width: 240, margin: 3 })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active) onError("Could not create the QR code. Copy the link instead.");
      });
    return () => {
      active = false;
    };
  }, [invitation.url]);
  async function copy(secret: boolean) {
    try {
      if (secret) await window.scope.copyPairingSecret(invitation.id);
      else await navigator.clipboard.writeText(invitation.url);
      setCopied(secret ? "Pairing secret copied." : "Link copied.");
    } catch (error) {
      onError(transferError(error));
    }
  }
  const waiting = invitation.state === "waiting";
  return (
    <div className="transfer-form">
      {waiting && (
        <>
          <p className="secondary">
            {pairing
              ? "On the other Scope, enter this link and the separate pairing secret."
              : "On the other Scope, choose Import tab and enter this link."}
          </p>
          {qr && (
            <img
              className="transfer-qr"
              src={qr}
              alt={pairing ? "Pairing QR code" : "Transfer QR code"}
            />
          )}
          <label>
            {pairing ? "Pairing link" : "Transfer link"}
            <Input readOnly value={invitation.url} spellCheck={false} />
          </label>
          <div className="installation-actions">
            <Button variant="secondary" onClick={() => void copy(false)}>
              Copy link
            </Button>
            {pairing && (
              <Button variant="secondary" onClick={() => void copy(true)}>
                Copy pairing secret
              </Button>
            )}
          </div>
          {copied && <p role="status">{copied}</p>}
          <p className="secondary">
            Expires at{" "}
            {new Date(invitation.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>
        </>
      )}
      {invitation.state === "importing" && (
        <p role="status">Import in progress. Keep Scope open.</p>
      )}
      {invitation.state === "delivered" && <p role="status">Tab imported on the other Scope.</p>}
      {invitation.state === "paired" && <p role="status">Scopes paired. You can now send tabs.</p>}
      {invitation.state === "expired" && (
        <p role="status">This invitation expired. Create a new link to retry.</p>
      )}
      {invitation.state === "cancelled" && <p role="status">Invitation cancelled.</p>}
    </div>
  );
}
