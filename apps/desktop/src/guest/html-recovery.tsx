import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { GuestRecord } from "./contract.ts";
import type { GuestField, GuestInput } from "./recovery-contract.ts";
import { captureField, recoverableFields, restoreFields } from "./html-fields.ts";
import { beforeClose, useAutosave } from "../workspace/persistence.ts";
import { Button } from "../renderer/components/ui/button.tsx";
import { Textarea } from "../renderer/components/ui/textarea.tsx";

function fieldText(field: GuestField) {
  return field.checked !== undefined
    ? field.checked
      ? "Checked"
      : "Unchecked"
    : (field.selected?.join(", ") ?? field.value);
}
function inputText(input: GuestInput) {
  return input.fields
    .map((field) => `${field.key.slice(field.key.indexOf(":") + 1)}: ${fieldText(field)}`)
    .join("\n");
}
function limitError(input: GuestInput) {
  if (input.fields.length > 64) return "More than 64 edited fields cannot be saved.";
  if (
    input.fields.some(
      (field) =>
        field.value.length > 8192 ||
        (field.selected?.length ?? 0) > 64 ||
        field.selected?.some((value) => value.length > 8192),
    )
  )
    return "This field exceeds recovery limits.";
  return "";
}

/** Working values belong to the guest, including when its owner replaces the document. */
export function GuestHtmlRecovery({
  record,
  available,
  children,
  controls,
  onOpenControls,
}: {
  record: GuestRecord;
  available: boolean;
  children: ReactNode;
  controls: HTMLDivElement | null;
  onOpenControls: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<{ document: Document; revision: number; blob: string } | undefined>(
    undefined,
  );
  const working = useRef(new Map<number, GuestInput>());
  const [inputs, setInputs] = useState<GuestInput[]>([]);
  const saved = useRef<GuestInput[]>([]);
  const [, render] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readError, setReadError] = useState(false);
  const [reading, setReading] = useState(false);
  const [ready, setReady] = useState(false);
  const [review, setReview] = useState(false);
  const loaded = useRef(false);
  const initialRead = useRef<Promise<void> | undefined>(undefined);
  const readSequence = useRef(0);
  const reload = useRef<() => Promise<void>>(async () => {});
  const current = useRef({ record, available });
  current.current = { record, available };
  const artifact = record.source.artifact;
  const updateSaved = (values: GuestInput[]) => {
    saved.current = values;
    setInputs(values);
  };
  const save = useAutosave(
    () => (loaded.current ? [...working.current.values()] : undefined),
    async (snapshot) => {
      for (const input of snapshot) {
        const failure = limitError(input);
        if (failure) throw new Error(failure);
        // Write exactly the immutable snapshot acknowledged by useAutosave.
        await window.scope.saveGuestInput(input);
        readSequence.current++;
        updateSaved([...saved.current.filter((value) => value.revision !== input.revision), input]);
      }
    },
    record.tab.id,
  );
  useLayoutEffect(() => {
    let live = true;
    const read = async () => {
      const sequence = ++readSequence.current;
      const recovery = await window.scope.guestRecovery(record.tab.id);
      if (!live || sequence !== readSequence.current) return;
      const values = recovery.inputs.filter((input) => input.kind === "html");
      if (!loaded.current) {
        for (const [revision, input] of working.current) {
          const previous = values.find(
            (value) =>
              value.revision === revision &&
              value.blob === input.blob &&
              value.ownerDeviceId === input.ownerDeviceId &&
              value.sourceTabId === input.sourceTabId,
          );
          const fields = new Map(previous?.fields.map((field) => [field.key, field]));
          for (const field of input.fields) fields.set(field.key, field);
          working.current.set(revision, { ...input, fields: [...fields.values()] });
        }
        loaded.current = true;
        save.schedule();
      }
      updateSaved(values);
      setReadError(false);
    };
    reload.current = () => {
      const sequence = readSequence.current + 1;
      setReading(true);
      const task = read();
      if (!loaded.current) initialRead.current = task;
      void task
        .catch(() => {
          if (!live || sequence !== readSequence.current) return;
          setReadError(true);
        })
        .finally(() => {
          if (live && sequence === readSequence.current) setReading(false);
        });
      return task;
    };
    void reload.current();
    const remove = window.scope.onGuestRecoveryChanged((id) => {
      if (id === record.tab.id && loaded.current) void reload.current().catch(() => {});
    });
    // Loading-time edits must merge before the close barrier captures its snapshot.
    const removeFlush = beforeClose(async () => {
      await initialRead.current;
      await save.flush();
    }, record.tab.id);
    return () => {
      live = false;
      remove();
      removeFlush();
    };
  }, [record.tab.id]);
  useLayoutEffect(() => {
    const element = container.current!;
    const capture = (event: Event) => {
      const attached = frame.current;
      const { record, available } = current.current;
      const artifact = record.source.artifact;
      if (
        !available ||
        !attached ||
        artifact?.kind !== "html" ||
        artifact.revision !== attached.revision ||
        artifact.blob !== attached.blob
      )
        return;
      const supported = recoverableFields(attached.document);
      const found = [...supported].find(([, field]) => field === event.target);
      if (!found) {
        setError(
          "This field is not recoverable. Passwords, files, sensitive fields and ambiguous identifiers are excluded; copy any input you need before closing.",
        );
        return;
      }
      const input = working.current.get(artifact.revision) ??
        saved.current.find(
          (value) => value.revision === artifact.revision && value.blob === artifact.blob,
        ) ?? {
          guestId: record.tab.id,
          ownerDeviceId: record.ownerDeviceId,
          sourceTabId: record.source.sourceTabId,
          revision: artifact.revision,
          blob: artifact.blob,
          kind: "html" as const,
          fields: [],
        };
      const fields = new Map(input.fields.map((field) => [field.key, field]));
      const related =
        found[1].tagName === "INPUT" && found[1].type === "radio"
          ? [...supported].filter(
              ([, field]) =>
                field.type === "radio" &&
                field.name === found[1].name &&
                field.form === found[1].form,
            )
          : [found];
      // Keep full working values even when they cannot fit the persisted recovery budget.
      for (const [key, field] of related) fields.set(key, captureField(key, field));
      working.current.set(artifact.revision, { ...input, fields: [...fields.values()] });
      setError("");
      setNotice("");
      render((value) => value + 1);
      save.schedule();
    };
    const detach = () => {
      frame.current?.document.removeEventListener("input", capture);
      frame.current?.document.removeEventListener("change", capture);
      frame.current = undefined;
    };
    const attach = () => {
      detach();
      setReady(false);
      const artifact = current.current.record.source.artifact;
      if (artifact?.kind !== "html") return;
      try {
        const document = element.querySelector("iframe")?.contentDocument;
        if (!document || document.location.href !== "about:srcdoc") return;
        frame.current = { document, revision: artifact.revision, blob: artifact.blob };
        document.addEventListener("input", capture);
        document.addEventListener("change", capture);
        setReady(true);
      } catch {
        /* Cross-origin authored content has no supported field recovery. */
      }
    };
    element.addEventListener("load", attach, true);
    attach();
    return () => {
      element.removeEventListener("load", attach, true);
      detach();
    };
  }, [artifact?.kind, artifact?.revision, artifact?.blob]);
  async function discard(input: GuestInput) {
    const captured = working.current.get(input.revision);
    try {
      await save.commit(
        () => [...working.current.values()],
        async () => {
          await initialRead.current;
          await window.scope.discardGuestInput(record.tab.id, "html", input.revision);
          return undefined;
        },
        () => {
          readSequence.current++;
          if (working.current.get(input.revision) === captured)
            working.current.delete(input.revision);
          updateSaved(saved.current.filter((value) => value.revision !== input.revision));
          setError("");
          setNotice("");
        },
      );
      await save.flush();
    } catch {
      setError("Could not discard input. Keep Scope open and retry.");
    }
  }
  const displayed = new Map(inputs.map((input) => [input.revision, input]));
  for (const [revision, input] of working.current) displayed.set(revision, input);
  const failure =
    error ||
    (readError
      ? "Could not read saved input. Keep Scope open and retry."
      : save.error
        ? "Could not save form input. Keep Scope open and retry."
        : "");
  const body =
    displayed.size > 0 || failure ? (
      <details
        className="guest-actions"
        open={review || readError || !!error || save.error}
        onToggle={(event) => setReview(event.currentTarget.open)}
      >
        <summary>
          Form input recovery
          {displayed.size ? ` · ${displayed.size} revision${displayed.size === 1 ? "" : "s"}` : ""}
        </summary>
        <div className="guest-actions-body">
          <p>
            Scope saves supported fields with unique names or labels. Passwords, files, sensitive
            fields and script state are excluded. HTML can still run scripts and make network
            requests.
          </p>
          {!available && (
            <p>The owner is unavailable. Recovery input stays here; no source writes are queued.</p>
          )}
          {[...displayed.values()].map((input) => {
            const persisted = inputs.find((value) => value.revision === input.revision);
            const unsaved = JSON.stringify(persisted) !== JSON.stringify(input);
            const same =
              artifact?.kind === "html" &&
              input.ownerDeviceId === record.ownerDeviceId &&
              input.sourceTabId === record.source.sourceTabId &&
              input.revision === artifact.revision &&
              input.blob === artifact.blob;
            return (
              <div key={input.revision}>
                <p>
                  {unsaved ? "Unsaved input" : "Saved input"} · owner revision {input.revision}
                  {same
                    ? ""
                    : ` · current revision ${artifact?.revision ?? "unavailable"}; copy or discard old input`}
                </p>
                {unsaved && (
                  <p role="status">
                    {limitError(input)} These working values are only in this window until saved.
                    Copy or discard them before closing.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {same && !unsaved && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!available || !ready || !loaded.current}
                      onClick={() => {
                        try {
                          restoreFields(frame.current!.document, input.fields);
                          setError("");
                          setNotice(
                            "Restored saved field values without submitting forms or running input handlers.",
                          );
                        } catch (error) {
                          setError(
                            error instanceof Error ? error.message : "Could not restore input.",
                          );
                        }
                      }}
                    >
                      Restore saved fields
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(inputText(input))
                        .catch(() =>
                          setError("Could not copy. Select and copy the retained values below."),
                        )
                    }
                  >
                    Copy {unsaved ? "unsaved" : "saved"} input
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!loaded.current}
                    onClick={() => void discard(input)}
                  >
                    Discard {unsaved ? "unsaved" : "saved"} input
                  </Button>
                </div>
                <details>
                  <summary>View {unsaved ? "unsaved" : "saved"} values</summary>
                  {input.fields.map((field) => (
                    <label key={field.key}>
                      {field.key.slice(field.key.indexOf(":") + 1)}
                      <Textarea readOnly value={fieldText(field)} rows={2} />
                    </label>
                  ))}
                </details>
              </div>
            );
          })}
          {notice && <p role="status">{notice}</p>}
          {(error || save.error) && (
            <p role="alert">{error || "Could not save form input. Keep Scope open and retry."}</p>
          )}
          {readError && <p role="alert">Could not read saved input. Keep Scope open and retry.</p>}
          {readError && (
            <Button
              size="sm"
              disabled={reading}
              onClick={() => void reload.current().catch(() => {})}
            >
              {reading ? "Reading saved input…" : "Retry reading input"}
            </Button>
          )}
          {save.error && (
            <Button size="sm" onClick={() => void save.flush().catch(() => {})}>
              Retry form save
            </Button>
          )}
        </div>
      </details>
    ) : null;
  return (
    <div ref={container} className="guest-recovery-view">
      {!controls && failure && (
        <div className="guest-notice" role="alert">
          <span>{failure}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setReview(true);
              onOpenControls();
            }}
          >
            Review form input
          </Button>
        </div>
      )}
      {controls && createPortal(body, controls)}
      {children}
    </div>
  );
}
