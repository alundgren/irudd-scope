import { createPortal } from "react-dom";
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
  controls,
  onOpenControls,
}: {
  record: GuestRecord;
  owner?: GuestCatalogView["owners"][number];
  available: boolean;
  controls: HTMLDivElement | null;
  onOpenControls: () => void;
}) {
  const [title, setTitle] = useState(record.source.title);
  const [draft, setDraft] = useState<GuestInput>();
  const [pending, setPending] = useState<GuestPending>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState(false);
  const [open, setOpen] = useState(false);
  const changed = useRef(false);
  const editGeneration = useRef(0);
  const draftRevisions = useRef(new Set<number>());
  const recoveryRead = useRef(0);
  const recoveryLoaded = useRef(false);
  const loadRecovery = useRef<() => Promise<void>>(async () => {});
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
    () => {
      if (!changed.current) return;
      // Include queued snapshots, not only the last acknowledged database write.
      draftRevisions.current.add(key.revision);
      return { ...key, kind: "action" as const, title, fields: [] };
    },
    async (value) => {
      await window.scope.saveGuestInput(value);
      setDraft(value);
    },
    record.tab.id,
  );
  useEffect(() => {
    let live = true;
    const read = async () => {
      const sequence = ++recoveryRead.current;
      const recovery = await window.scope.guestRecovery(record.tab.id);
      if (!live || sequence !== recoveryRead.current) return;
      const actions = recovery.inputs.filter((input) => input.kind === "action");
      for (const input of actions) draftRevisions.current.add(input.revision);
      const action = actions.at(-1);
      setReadError(false);
      setPending(recovery.pending);
      setDraft(action);
      if (!recoveryLoaded.current) {
        if (action?.title !== undefined && !changed.current) {
          setTitle(action.title);
          expected.current.revision = action.revision;
          expected.current.sourceVersion = action.sourceVersion;
        }
        recoveryLoaded.current = true;
        setLoaded(true);
        if (action || recovery.pending) setOpen(true);
      }
    };
    loadRecovery.current = read;
    const remove = window.scope.onGuestRecoveryChanged((id) => {
      if (id === record.tab.id)
        void read().catch(() => {
          if (live) setReadError(true);
        });
    });
    void read().catch(() => {
      if (live) setReadError(true);
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
    await loadRecovery.current();
  }
  function titleInput() {
    return {
      generation: editGeneration.current,
      revisions: new Set([...draftRevisions.current, key.revision]),
    };
  }
  async function clearTitle(input: ReturnType<typeof titleInput>, resetTitle: boolean) {
    await save.commit(
      () => ({ ...key, kind: "action" as const, title, fields: [] }),
      async () => {
        // Later edits may reuse the same revision row while this cleanup is queued.
        if (editGeneration.current !== input.generation) return undefined;
        for (const revision of input.revisions)
          await window.scope.discardGuestInput(record.tab.id, "action", revision);
        return undefined;
      },
      () => {
        recoveryRead.current++;
        if (editGeneration.current === input.generation) {
          draftRevisions.current.clear();
          changed.current = false;
          setDraft(undefined);
          if (resetTitle) setTitle(record.source.title);
        }
      },
    );
  }
  async function run(action: GuestAction) {
    if (!record.source.sourceVersion) return;
    setBusy(true);
    setError("");
    setNotice("");
    const submitted = titleInput();
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
      (outcome.state === "completed" || outcome.state === "prepared" ? setNotice : setError)(
        outcome.message ?? (outcome.state === "completed" ? "" : outcome.state),
      );
      if (outcome.state === "completed") {
        await window.scope.guestReconcile(target, operation);
        if (action.kind === "rename") await clearTitle(submitted, false);
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
    setNotice("");
    try {
      if (pending) {
        const result = await window.scope.guestReconcile(target, pending.operation);
        setNotice(
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
        setNotice(
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
  const body = (
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
              editGeneration.current++;
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
        {draft && !pending && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              const input = titleInput();
              setBusy(true);
              void clearTitle(input, true)
                .catch((error) => setError(message(error)))
                .finally(() => setBusy(false));
            }}
          >
            Discard title draft
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
                .then((outcome) => {
                  setError("");
                  setNotice("");
                  (outcome.state === "completed" || outcome.state === "prepared"
                    ? setNotice
                    : setError)(outcome.message ?? `Operation ${outcome.state}.`);
                })
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
        {notice && <p role="status">{notice}</p>}
        {readError && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void refresh()
                .then(() => setError(""))
                .catch((error) => setError(message(error)))
                .finally(() => setBusy(false));
            }}
          >
            Retry source recovery
          </Button>
        )}
        {readError && (
          <p role="alert">Could not read source recovery. Retry to review saved changes.</p>
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
  return (
    <>
      {!controls &&
        (error ||
          save.error ||
          readError ||
          (pending &&
            !busy &&
            pending.outcome.state !== "completed" &&
            (pending.dispatched || pending.outcome.state !== "prepared"))) && (
          <div className="guest-notice" role="alert">
            <span>
              {save.error
                ? "Could not save source input."
                : readError
                  ? "Could not read source recovery."
                  : error || "Source operation needs review."}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setOpen(true);
                onOpenControls();
              }}
            >
              Review source actions
            </Button>
          </div>
        )}
      {controls && createPortal(body, controls)}
    </>
  );
}
