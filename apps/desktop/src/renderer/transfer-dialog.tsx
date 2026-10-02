import { useEffect, useState, type ComponentProps } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { X } from "lucide-react";
import { flushWorkspace } from "../workspace/persistence.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { PairScopeForm } from "./transfer-settings.tsx";
import {
  TransferInvitation,
  transferError,
  useInvitationStatus,
  type Invitation,
} from "./transfer-invitation.tsx";

type TransferDialogFocus = ComponentProps<typeof DialogContent>["finalFocus"];

export function SendTabDialog({
  tabId,
  title,
  onClose,
  onPair,
  finalFocus,
}: {
  tabId: string;
  title: string;
  onClose: () => void;
  onPair: () => void;
  finalFocus?: TransferDialogFocus;
}) {
  const [devices, setDevices] =
    useState<Awaited<ReturnType<typeof window.scope.transferDevices>>>();
  const [peerId, setPeerId] = useState("");
  const [invitation, setInvitation] = useState<Invitation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const value = await window.scope.transferDevices();
      setDevices(value);
      setPeerId(value.peers[0]?.id ?? "");
    } catch (error) {
      setError(transferError(error));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useInvitationStatus(
    invitation,
    (value) => {
      setInvitation(value);
      setError("");
    },
    setError,
  );
  async function send() {
    setBusy(true);
    setError("");
    try {
      await flushWorkspace();
      setInvitation(await window.scope.sendTab({ tabId, peerId }));
    } catch (error) {
      setError(transferError(error));
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy || invitation?.state === "importing") return;
    setBusy(true);
    try {
      if (invitation?.state === "waiting") await window.scope.cancelTransfer(invitation.id);
      onClose();
    } catch (error) {
      setError(transferError(error));
    } finally {
      setBusy(false);
    }
  }
  const closingDisabled = busy || invitation?.state === "importing";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="transfer-dialog" showCloseButton={false} finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Send tab</DialogTitle>
        </DialogHeader>
        <Button
          className="absolute top-2 right-2"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          disabled={closingDisabled}
          onClick={() => void close()}
        >
          <X />
        </Button>
        <p className="transfer-title">{title}</p>
        {!invitation && (
          <>
            {!devices && !error && <p role="status">Loading other Scopes…</p>}
            {devices?.peers.length === 0 && (
              <>
                <p>No other Scopes paired.</p>
                <Button variant="secondary" onClick={onPair}>
                  Pair another Scope
                </Button>
              </>
            )}
            {!!devices?.peers.length && (
              <>
                <label>
                  Send to
                  <NativeSelect
                    value={peerId}
                    disabled={busy}
                    onChange={(event) => setPeerId(event.target.value)}
                  >
                    {devices.peers.map((peer) => (
                      <NativeSelectOption key={peer.id} value={peer.id}>
                        {peer.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <p className="secondary">
                  Send a copy of this tab. The other Scope reviews it before importing.
                </p>
                <Button disabled={busy || !peerId} onClick={() => void send()}>
                  {busy ? "Preparing…" : "Create transfer link"}
                </Button>
              </>
            )}
          </>
        )}
        {invitation && (
          <>
            <TransferInvitation invitation={invitation} onError={setError} />
            <div className="installation-actions">
              {["expired", "cancelled"].includes(invitation.state) && (
                <Button disabled={busy} onClick={() => void send()}>
                  Create new link
                </Button>
              )}
              <Button variant="secondary" disabled={closingDisabled} onClick={() => void close()}>
                {invitation.state === "waiting"
                  ? "Cancel transfer"
                  : invitation.state === "importing"
                    ? "Import in progress"
                    : "Done"}
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {!devices && error && (
          <Button variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ImportTabDialog({
  initialUrl = "",
  onClose,
  onImported,
  finalFocus,
}: {
  initialUrl?: string;
  onClose: () => void;
  onImported: (artifact: Artifact) => Promise<void>;
  finalFocus?: TransferDialogFocus;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [preview, setPreview] =
    useState<Awaited<ReturnType<typeof window.scope.inspectTransfer>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setPreview(await window.scope.inspectTransfer(url.trim()));
    } catch (error) {
      setError(transferError(error));
    } finally {
      setBusy(false);
    }
  }
  async function importTab() {
    setBusy(true);
    setError("");
    try {
      const result = await window.scope.importTransfer(url.trim());
      await onImported(result.artifact);
      onClose();
    } catch (error) {
      setError(transferError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="transfer-dialog" showCloseButton={false} finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Import tab</DialogTitle>
        </DialogHeader>
        <Button
          className="absolute top-2 right-2"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </Button>
        {!preview ? (
          <form
            className="transfer-form"
            onSubmit={(event) => {
              event.preventDefault();
              void inspect();
            }}
          >
            <label>
              Transfer link
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                autoFocus
                required
              />
            </label>
            <p className="secondary">
              Enter a link from a paired Scope. You can review the tab before importing it.
            </p>
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? "Checking…" : "Review tab"}
            </Button>
          </form>
        ) : (
          <>
            <p className="transfer-title">{preview.title}</p>
            <dl className="artifact-details">
              <dt>From</dt>
              <dd>{preview.sourceName}</dd>
              <dt>Kind</dt>
              <dd>{preview.kind}</dd>
              <dt>File</dt>
              <dd>{preview.fileName}</dd>
              <dt>Size</dt>
              <dd>{new Intl.NumberFormat().format(preview.size)} bytes</dd>
              <dt>Expires</dt>
              <dd>
                {new Date(preview.expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </dd>
            </dl>
            <p className="secondary">
              {preview.alreadyImported
                ? "This tab is already imported. Open your local copy."
                : preview.kind === "html"
                  ? "This adds a local copy of the tab. Imported HTML can run scripts and use the network."
                  : "This adds a local copy of the tab."}
            </p>
            <div className="installation-actions">
              <Button disabled={busy} onClick={() => void importTab()}>
                {busy ? "Importing…" : preview.alreadyImported ? "Open existing tab" : "Import tab"}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setPreview(undefined);
                  setError("");
                }}
              >
                Use another link
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

export function PairScopeDialog({
  url,
  onClose,
  finalFocus,
}: {
  url: string;
  onClose: () => void;
  finalFocus?: TransferDialogFocus;
}) {
  const [paired, setPaired] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="transfer-dialog" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Pair another Scope</DialogTitle>
        </DialogHeader>
        {paired ? (
          <>
            <p role="status">Scopes paired. You can now send tabs.</p>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <PairScopeForm initialUrl={url} onCancel={onClose} onPaired={() => setPaired(true)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
