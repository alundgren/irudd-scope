import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { SettingsSection } from "./settings-section.tsx";
import {
  TransferInvitation,
  transferError,
  useInvitationStatus,
  type Invitation,
} from "./transfer-invitation.tsx";

type Devices = Awaited<ReturnType<typeof window.scope.transferDevices>>;

export function PairScopeForm({
  initialUrl = "",
  onPaired,
  onCancel,
  onBusyChange,
}: {
  initialUrl?: string;
  onPaired: () => void;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void window.scope
      .transferDevices()
      .then((devices) => setName(devices.name))
      .catch((error: unknown) => setError(transferError(error)));
  }, []);
  return (
    <form
      className="transfer-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        onBusyChange?.(true);
        setError("");
        void window.scope
          .pairScope({ url: url.trim(), secret: secret.trim(), name: name.trim() })
          .then(() => {
            setSecret("");
            setUrl("");
            onPaired();
          })
          .catch((error: unknown) => setError(transferError(error)))
          .finally(() => {
            setBusy(false);
            onBusyChange?.(false);
          });
      }}
    >
      <label>
        This Scope's name
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          required
        />
      </label>
      <label>
        Pairing link
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          required
        />
      </label>
      <label>
        Pairing secret
        <Input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          required
        />
      </label>
      <p className="secondary">
        Ask the other Scope to create a pairing invitation in Settings, then send you its link and
        secret separately.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="installation-actions">
        <Button type="submit" disabled={busy || !name.trim() || !url.trim() || !secret.trim()}>
          {busy ? "Pairing…" : "Pair Scope"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setSecret("");
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function TransferSettings({ query }: { query: string }) {
  return (
    <SettingsSection id="transfers" query={query}>
      <TransferDevices />
    </SettingsSection>
  );
}

function TransferDevices() {
  const [devices, setDevices] = useState<Devices>();
  const [name, setName] = useState("");
  const [task, setTask] = useState<"create" | "enter">();
  const [invitation, setInvitation] = useState<Invitation>();
  const mounted = useRef(true);
  const [forget, setForget] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    const value = await window.scope.transferDevices();
    setDevices(value);
    setName(value.name);
  }
  useEffect(() => {
    mounted.current = true;
    void load().catch((error: unknown) => setError(transferError(error)));
    return () => {
      mounted.current = false;
    };
  }, []);
  useInvitationStatus(
    invitation,
    (value) => {
      setInvitation(value);
      setError("");
      if (value.state === "paired")
        void load().catch((error: unknown) => setError(transferError(error)));
    },
    setError,
  );
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(transferError(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (invitation?.state === "waiting") await window.scope.cancelTransfer(invitation.id);
    setInvitation(undefined);
    setTask(undefined);
  }
  async function create() {
    const value = await window.scope.createPairing(name.trim());
    if (mounted.current) setInvitation(value);
  }
  return (
    <div className="transfer-form">
      {!devices && !error && <p role="status">Loading other Scopes…</p>}
      {devices && !task && (
        <>
          <p className="secondary">
            This Scope is named {devices.name}. Paired Scopes can exchange a copy of a tab while
            both apps are open.
          </p>
          {devices.credentialStorage === "session" && (
            <p className="secondary">Pairing lasts until this app closes on this device.</p>
          )}
          <div className="installation-actions">
            <Button variant="secondary" onClick={() => setTask("create")}>
              Create pairing invitation
            </Button>
            <Button variant="secondary" onClick={() => setTask("enter")}>
              Enter pairing link
            </Button>
          </div>
        </>
      )}
      {task === "enter" && (
        <PairScopeForm
          onPaired={() => {
            setTask(undefined);
            void run(load);
          }}
          onCancel={() => setTask(undefined)}
        />
      )}
      {task === "create" && (
        <>
          {!invitation ? (
            <form
              className="transfer-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(create);
              }}
            >
              <label>
                This Scope's name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                  required
                />
              </label>
              <div className="installation-actions">
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? "Creating…" : "Create pairing link"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setTask(undefined)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <TransferInvitation invitation={invitation} pairing onError={setError} />
              <div className="installation-actions">
                {["expired", "cancelled"].includes(invitation.state) && (
                  <Button disabled={busy} onClick={() => void run(create)}>
                    Create new link
                  </Button>
                )}
                <Button variant="secondary" disabled={busy} onClick={() => void run(cancel)}>
                  {invitation.state === "waiting" ? "Cancel invitation" : "Done"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {!task && devices?.peers.length === 0 && <p className="secondary">No other Scopes paired.</p>}
      {!task &&
        devices?.peers.map((peer) => (
          <div className="installation-tool" key={peer.id}>
            <strong>{peer.name}</strong>
            {forget === peer.id ? (
              <>
                <p>Forget {peer.name}? You will need to pair again to exchange tabs.</p>
                <div className="installation-actions">
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.scope.forgetScope(peer.id);
                        setForget(undefined);
                        await load();
                      })
                    }
                  >
                    Forget Scope
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setForget(undefined)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => setForget(peer.id)}>
                Forget {peer.name}
              </Button>
            )}
          </div>
        ))}
      {error && (
        <>
          <p role="alert">{error}</p>
          {!devices && (
            <Button variant="secondary" disabled={busy} onClick={() => void run(load)}>
              Retry
            </Button>
          )}
        </>
      )}
    </div>
  );
}
