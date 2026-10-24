import { useEffect, useRef, useState } from "react";
import type { GuestAction, GuestChange } from "@irudd-scope/protocol/guest-operation";
import type { GuestCatalogView, GuestRecord } from "./contract.ts";
import type { GuestInput, GuestPending } from "./recovery-contract.ts";
import { useAutosave } from "../workspace/persistence.ts";
import { Button } from "../renderer/components/ui/button.tsx";
import { Input } from "../renderer/components/ui/input.tsx";

function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : "Source change failed. Your input is retained.";
}
export function GuestActions({
  record,
  owner,
  available,
}: {
  record: GuestRecord;
  owner?: GuestCatalogView["owners"][number];
  available: boolean;
}) {
  const [title, setTitle] = useState(record.source.title);
  const [draft, setDraft] = useState<GuestInput>();
  const [pending, setPending] = useState<GuestPending>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const changed = useRef(false);
  const expected = useRef({
    sourceVersion: record.source.sourceVersion,
    revision: record.source.artifact?.revision ?? 0,
  });
  const key = {
    guestId: record.tab.id,
    ownerDeviceId: record.ownerDeviceId,
    sourceTabId: record.source.sourceTabId,
    revision: expected.current.revision,
    sourceVersion: expected.current.sourceVersion,
  };
  const target = { ownerDeviceId: record.ownerDeviceId, sourceTabId: record.source.sourceTabId };
  const save = useAutosave(
    () => (changed.current ? { ...key, kind: "action" as const, title, fields: [] } : undefined),
    async (value) => {
      await window.scope.saveGuestInput(value);
      setDraft(value);
    },
    record.tab.id,
  );
  useEffect(() => {
    let live = true;
    const remove = window.scope.onGuestRecoveryChanged((id) => {
      if (id === record.tab.id)
        void window.scope
          .guestRecovery(id)
          .then((recovery) => {
            if (live) {
              setPending(recovery.pending);
              setDraft(recovery.inputs.filter((input) => input.kind === "action").at(-1));
            }
          })
          .catch(() => setError("Could not refresh saved recovery data."));
    });
    void window.scope
      .guestRecovery(record.tab.id)
      .then((recovery) => {
        if (!live) return;
        const action = recovery.inputs.filter((input) => input.kind === "action").at(-1);
        setPending(recovery.pending);
        setDraft(action);
        if (action?.title !== undefined && !changed.current) {
          setTitle(action.title);
          expected.current.revision = action.revision;
          expected.current.sourceVersion = action.sourceVersion;
        }
        setLoaded(true);
        if (action || recovery.pending) setOpen(true);
      })
      .catch((error) => {
        if (live) setError(message(error));
      });
    return () => {
      live = false;
      remove();
    };
  }, [record.tab.id]);
  useEffect(() => {
    if (!changed.current && !draft && !pending) {
      expected.current = {
        sourceVersion: record.source.sourceVersion,
        revision: record.source.artifact?.revision ?? 0,
      };
      setTitle(record.source.title);
    }
  }, [record.source, draft, pending]);
  async function refresh() {
    const recovery = await window.scope.guestRecovery(record.tab.id);
    setPending(recovery.pending);
  }
  async function run(action: GuestAction) {
    if (!record.source.sourceVersion) return;
    setBusy(true);
    setError("");
    try {
      await save.flush();
      const change: GuestChange = {
        version: 1,
        target,
        expectedSourceVersion: expected.current.sourceVersion!,
        expectedRevision: expected.current.revision,
        action,
      };
      const operation = await window.scope.guestPrepare(change);
      const outcome = await window.scope.guestExecute(target, operation);
      setError(outcome.message ?? (outcome.state === "completed" ? "" : outcome.state));
      if (outcome.state === "completed") {
        await window.scope.guestReconcile(target, operation);
        changed.current = false;
        if (draft) await window.scope.discardGuestInput(record.tab.id, "action", draft.revision);
        await window.scope.discardGuestInput(record.tab.id, "action", key.revision);
        setDraft(undefined);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      await refresh().catch(() => {});
      setBusy(false);
    }
  }
  async function reconcile() {
    setBusy(true);
    setError("");
    try {
      if (pending) {
        const result = await window.scope.guestReconcile(target, pending.operation);
        setError(
          result.source
            ? `Current owner revision ${result.source.artifact?.revision ?? result.source.sourceVersion}. Input retained; review it before making a new change.`
            : "The owner no longer shares this source. Input is retained.",
        );
        if (result.source)
          expected.current = {
            sourceVersion: result.source.sourceVersion,
            revision: result.source.artifact?.revision ?? 0,
          };
      } else {
        expected.current = {
          sourceVersion: record.source.sourceVersion,
          revision: record.source.artifact?.revision ?? 0,
        };
        setError(
          `Current owner revision ${expected.current.revision}. Review your retained input before saving.`,
        );
      }
      await refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  const enabled =
    available &&
    owner?.mutations === true &&
    !!record.source.sourceVersion &&
    loaded &&
    !busy &&
    !pending;
  return (
    <details
      className="guest-actions"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Source actions · {owner?.name ?? "owner"}</summary>
      <div className="guest-actions-body">
        <p>Changes apply on {owner?.name ?? "the owner"}. Close tab only hides this guest here.</p>
        <p>
          Owner revision{" "}
          {record.source.artifact?.revision ?? record.source.sourceVersion ?? "unavailable"} ·{" "}
          {record.source.permanent ? "Kept permanently" : "Temporary"}
        </p>
        {owner?.mutations !== true && <p>Reconnect or update the owner to use source actions.</p>}
        <label>
          Source title on {owner?.name ?? "owner"}
          <Input
            aria-label="Source title"
            value={title}
            disabled={!available || !loaded || busy || !!pending}
            onChange={(event) => {
              changed.current = true;
              setTitle(event.target.value);
              save.schedule();
            }}
            maxLength={160}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!enabled || !title.trim()}
            onClick={() => void run({ kind: "rename", title })}
          >
            Rename on {owner?.name ?? "owner"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!enabled}
            onClick={() => void run({ kind: "retention", permanent: !record.source.permanent })}
          >
            {record.source.permanent ? "Make temporary" : "Keep permanently"} on{" "}
            {owner?.name ?? "owner"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!enabled}
            onClick={() => void run({ kind: "trash" })}
          >
            Move source to Trashcan on {owner?.name ?? "owner"}
          </Button>
        </div>
        {pending && (
          <p role="status">
            Saved operation{" "}
            {pending.dispatched && pending.outcome.state === "prepared"
              ? "awaiting owner status"
              : pending.outcome.state}
            .{" "}
            {pending.outcome.artifact &&
              `Current owner revision ${pending.outcome.artifact.revision}. `}
            Input and operation identity are retained. Further source changes are blocked until
            reconciled.
          </p>
        )}
        {(pending || draft) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={owner?.state !== "connected" || busy}
            onClick={() => void reconcile()}
          >
            Review current owner source
          </Button>
        )}
        {pending && (
          <Button
            size="sm"
            variant="secondary"
            disabled={owner?.state !== "connected" || busy}
            onClick={() => {
              setBusy(true);
              void window.scope
                .guestOperationStatus(target, pending.operation)
                .then((outcome) => setError(outcome.message ?? `Operation ${outcome.state}.`))
                .catch((error) => setError(message(error)))
                .finally(() => {
                  void refresh();
                  setBusy(false);
                });
            }}
          >
            Check operation status
          </Button>
        )}
        {(error || save.error) && (
          <p role="alert">
            {save.error ? "Could not save recovery input. Keep Scope open and retry." : error}
          </p>
        )}
        {save.error && (
          <Button size="sm" onClick={() => void save.flush().catch(() => {})}>
            Retry input save
          </Button>
        )}
      </div>
    </details>
  );
}
