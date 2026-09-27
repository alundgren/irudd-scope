import { useEffect, useState, type ReactNode } from "react";
import type { UpdateStatus } from "../installation-contract.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export function SigningSettings({
  status,
  disabled,
  progress,
}: {
  status: UpdateStatus | undefined;
  disabled: boolean;
  progress: ReactNode;
}) {
  const [reference, setReference] = useState("");
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const identity = status?.currentSigningIdentity;
  const available = Boolean(status?.currentCommit);
  const changing = status?.operation === "signing";
  useEffect(() => {
    let active = true;
    setName("");
    setMissing(false);
    if (identity)
      void window.scope.signingCertificate().then(
        (certificate) => {
          if (active) setName(certificate?.name ?? "");
        },
        () => {
          if (active) setMissing(true);
        },
      );
    return () => {
      active = false;
    };
  }, [identity]);
  useEffect(() => {
    if (status?.nextSigningCertificate)
      setReference((current) => current || status.nextSigningCertificate!.name);
  }, [status?.nextSigningCertificate]);
  function run(action: () => Promise<void>) {
    setError("");
    void action().catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Could not change the certificate. Try again.",
      ),
    );
  }
  return (
    <>
      <p className="secondary">
        Optional. Reuse a signing certificate to reduce Keychain permission prompts after updates.
      </p>
      {!available && <p>Certificate signing is available in the installed Mac app.</p>}
      {available && (
        <>
          <p>
            {identity ? `Current certificate: ${name || "connected"}` : "No certificate connected."}
          </p>
          {identity && (
            <details className="installation-output">
              <summary>Certificate fingerprint</summary>
              <p className="installation-path">
                <code>{identity}</code>
              </p>
            </details>
          )}
          {missing && (
            <p role="alert">
              This app's certificate could not be found in Keychain. Restore it or connect another
              certificate before updating.
            </p>
          )}
        </>
      )}
      <details className="signing-instructions">
        <summary>How to create a certificate</summary>
        <ol>
          <li>
            Open Keychain Access and select <strong>login</strong> in the sidebar.
          </li>
          <li>
            In the menu bar at the top of your screen, choose{" "}
            <strong>Keychain Access → Certificate Assistant → Create a Certificate…</strong>
          </li>
          <li>
            Name it <strong>Scope Local Signing</strong>. Choose <strong>Self Signed Root</strong>{" "}
            for Identity Type and <strong>Code Signing</strong> for Certificate Type.
          </li>
          <li>
            Create it in the login keychain. Keep the certificate and its private key for future
            updates.
          </li>
        </ol>
        <Button
          type="button"
          variant="secondary"
          disabled={!available}
          onClick={() => run(() => window.scope.openKeychainAccess())}
        >
          Open Keychain Access
        </Button>
      </details>
      <label>
        Certificate name or fingerprint
        <Input
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!disabled && available && reference.trim())
                run(() => window.scope.connectSigningCertificate(reference.trim()));
            }
          }}
          placeholder="Scope Local Signing"
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          disabled={disabled || !available}
        />
      </label>
      {disabled && !changing && (
        <p className="secondary">
          Finish or cancel the current app update or tool installation before changing the
          certificate.
        </p>
      )}
      <p className="secondary">
        Connecting rebuilds Scope on this Mac. Restart when ready to apply it. macOS may ask you to
        approve signing.
      </p>
      <p className="secondary">
        On first access, macOS may ask to let &quot;Scope Credentials&quot; use your saved
        credentials. Choose Always Allow to remember this permission across ordinary app updates.
        Changes to the credential helper or certificate, or a locked Keychain, can require another
        approval.
      </p>
      {status?.phase === "ready" && !changing && (
        <p className="secondary">The prepared update will be rebuilt with this certificate.</p>
      )}
      <div className="installation-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !available || !reference.trim()}
          onClick={() => run(() => window.scope.connectSigningCertificate(reference.trim()))}
        >
          Connect certificate
        </Button>
        {identity && (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => run(() => window.scope.disconnectSigningCertificate())}
          >
            Disconnect certificate
          </Button>
        )}
      </div>
      {identity && (
        <p className="secondary">
          Disconnecting rebuilds Scope with default signing and may bring back Keychain prompts. The
          certificate stays in Keychain.
        </p>
      )}
      {progress}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
