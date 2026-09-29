import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { activeShare, type SharingView } from "../sharing-contract.ts";
import type { Share } from "@irudd-scope/protocol/sharing";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

export function useSharing() {
  const [services, setServices] = useState<SharingView[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const unsubscribe = window.scope.onSharingChange(setServices);
    void window.scope
      .sharing()
      .then(setServices)
      .catch(() => setError("Could not load sharing services. Reopen this view to retry."));
    return unsubscribe;
  }, []);
  return { services, error };
}

function SharedCopy({
  service,
  share,
  tabId,
  busy,
  run,
}: {
  service: SharingView;
  share: Share;
  tabId?: string;
  busy: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const [copied, setCopied] = useState(false);
  const pending = service.pendingStops.includes(share.id) || service.removing;
  return (
    <div className="shared-copy">
      <strong className="sharing-title">{share.title}</strong>
      <p className="secondary">
        {service.name} ·{" "}
        {pending
          ? "Stop pending"
          : share.status === "starting"
            ? "Checking link status"
            : service.connected
              ? "Shared copy"
              : "Last known shared copy"}
      </p>
      {share.url && !pending && (
        <>
          <div className="share-qr">
            <QRCodeSVG
              value={share.url}
              size={256}
              marginSize={4}
              title="Scan to open the shared copy"
              role="img"
              aria-label="Scan to open the shared copy"
            />
          </div>
          <label>
            Public link
            <Input
              aria-label="Public share link"
              readOnly
              value={share.url}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await navigator.clipboard.writeText(share.url!);
                setCopied(true);
              })
            }
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <p className="secondary">
            Ends by {new Date(share.expiresAt).toLocaleString()}. The link may stop sooner.
          </p>
        </>
      )}
      {pending && (
        <p role="status">Waiting for the service to confirm the stop. The link may still work.</p>
      )}
      <div className="installation-actions">
        {tabId === share.tabId && share.status === "active" && !pending && (
          <Button
            variant="secondary"
            disabled={busy || !service.connected}
            onClick={() => run(() => window.scope.shareTab(service.id, tabId, share.id))}
          >
            Refresh shared content
          </Button>
        )}
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => run(() => window.scope.stopShare(service.id, share.id))}
        >
          {pending ? "Retry stop" : "Stop sharing"}
        </Button>
      </div>
      {service.message && <p role="status">{service.message}</p>}
    </div>
  );
}

export function SharingDialog({
  open,
  onOpenChange,
  tabId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabId?: string;
  title?: string;
}) {
  const { services, error: loadError } = useSharing();
  const [destinationId, setDestinationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copies = services.flatMap((service) =>
    service.shares
      .filter((share) => activeShare(share) && (!tabId || share.tabId === tabId))
      .map((share) => ({ service, share })),
  );
  const available = services.filter((service) => !service.removing);
  const destination = available.find((service) => service.id === destinationId) ?? available[0];
  function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    void action()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Sharing failed. Retry."))
      .finally(() => setBusy(false));
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sharing-dialog">
        <DialogHeader>
          <DialogTitle>{tabId ? "Share tab" : "Public shares"}</DialogTitle>
        </DialogHeader>
        {copies.length ? (
          copies.map(({ service, share }) => (
            <SharedCopy
              key={share.id}
              service={service}
              share={share}
              tabId={tabId}
              busy={busy}
              run={run}
            />
          ))
        ) : tabId && destination ? (
          <>
            <p className="sharing-title">{title}</p>
            <p className="secondary">
              Share a frozen, read-only copy. Anyone with its link can view and save it. Closing
              this tab keeps the shared copy available.
            </p>
            <label>
              Sharing service
              <NativeSelect
                aria-label="Sharing service"
                value={destination.id}
                disabled={busy}
                onChange={(event) => setDestinationId(event.target.value)}
              >
                {available.map((service) => (
                  <NativeSelectOption key={service.id} value={service.id}>
                    {service.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <p className="secondary installation-path">{destination.endpoint}</p>
            <Button
              disabled={busy}
              onClick={() => run(() => window.scope.shareTab(destination.id, tabId))}
            >
              {busy ? "Preparing shared copy…" : "Share publicly…"}
            </Button>
          </>
        ) : (
          <p className="secondary">No active shares.</p>
        )}
        {copies.length > 0 && (
          <p className="secondary">
            Shared content is frozen. Refresh replaces the copy without extending its expiry.
            Viewers reload to see changes.
          </p>
        )}
        {(error || loadError) && <p role="alert">{error || loadError}</p>}
      </DialogContent>
    </Dialog>
  );
}
