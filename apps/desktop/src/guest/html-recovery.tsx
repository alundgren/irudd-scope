import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { GuestRecord } from "./contract.ts";
import type { GuestField, GuestInput } from "./recovery-contract.ts";
import { captureField, recoverableFields, restoreFields } from "./html-fields.ts";
import { useAutosave } from "../workspace/persistence.ts";
import { Button } from "../renderer/components/ui/button.tsx";

/** Field drafts are receiver data. The authored document remains untouched and trusted. */
export function GuestHtmlRecovery({
  record,
  available,
  children,
}: {
  record: GuestRecord;
  available: boolean;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<Document | undefined>(undefined);
  const fields = useRef(new Map<string, GuestField>());
  const [inputs, setInputs] = useState<GuestInput[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [review, setReview] = useState(false);
  const dirty = useRef(false);
  const captureError = useRef("");
  const current = useRef({ available, loaded });
  current.current = { available, loaded };
  const artifact = record.source.artifact!;
  const key = {
    guestId: record.tab.id,
    ownerDeviceId: record.ownerDeviceId,
    sourceTabId: record.source.sourceTabId,
    revision: artifact.revision,
    blob: artifact.blob,
  };
  const save = useAutosave(
    () => {
      if (!dirty.current) return;
      return { ...key, kind: "html" as const, fields: [...fields.current.values()] };
    },
    async (value) => {
      if (captureError.current) throw new Error(captureError.current);
      await window.scope.saveGuestInput(value);
      setInputs((inputs) => [
        ...inputs.filter((input) => input.revision !== value.revision),
        value,
      ]);
    },
    record.tab.id,
  );
  useLayoutEffect(() => {
    let live = true;
    void window.scope
      .guestRecovery(record.tab.id)
      .then((recovery) => {
        if (!live) return;
        const inputs = recovery.inputs.filter((input) => input.kind === "html");
        setInputs(inputs);
        setLoaded(true);
        const saved = inputs.find(
          (input) => input.revision === artifact.revision && input.blob === artifact.blob,
        );
        for (const field of saved?.fields ?? [])
          if (!fields.current.has(field.key)) fields.current.set(field.key, field);
      })
      .catch(() => {
        if (live)
          setError("Could not read saved input. Keep this tab open and retry by reopening Scope.");
      });
    const element = container.current!;
    const capture = (event: Event) => {
      if (!current.current.available || !frame.current) return;
      const supported = recoverableFields(frame.current);
      const found = [...supported].find(([, field]) => field === event.target);
      if (!found) {
        setError(
          "This field is not recoverable. Passwords, files, sensitive fields and ambiguous identifiers are excluded; copy any input you need before closing.",
        );
        return;
      }
      dirty.current = true;
      try {
        if (!fields.current.has(found[0]) && fields.current.size >= 64)
          throw new Error(
            "More than 64 edited fields cannot be saved. Copy your input before closing.",
          );
        fields.current.set(found[0], captureField(...found));
        captureError.current = "";
        setError("");
        save.schedule();
      } catch (error) {
        captureError.current = error instanceof Error ? error.message : "Could not capture input.";
        setError(captureError.current);
        save.schedule();
      }
    };
    const detach = () => {
      frame.current?.removeEventListener("input", capture);
      frame.current?.removeEventListener("change", capture);
      frame.current = undefined;
    };
    const attach = () => {
      detach();
      try {
        const document = element.querySelector("iframe")?.contentDocument;
        if (!document || document.location.href !== "about:srcdoc") {
          setReady(false);
          return;
        }
        frame.current = document;
        document.addEventListener("input", capture);
        document.addEventListener("change", capture);
        setReady(true);
      } catch {
        setReady(false);
      }
    };
    element.addEventListener("load", attach, true);
    attach();
    return () => {
      live = false;
      element.removeEventListener("load", attach, true);
      detach();
    };
  }, []);
  async function discard(input: GuestInput) {
    try {
      await save.flush();
      if (input.revision === artifact.revision) {
        dirty.current = false;
        fields.current.clear();
        captureError.current = "";
      }
      await window.scope.discardGuestInput(record.tab.id, "html", input.revision);
      setInputs((values) => values.filter((value) => value.revision !== input.revision));
    } catch {
      setError("Could not discard input. Retry after saving succeeds.");
    }
  }
  return (
    <div ref={container} className="guest-recovery-view">
      <details
        className="guest-actions"
        open={review || !!error || save.error}
        onToggle={(event) => setReview(event.currentTarget.open)}
      >
        <summary>
          Form input recovery
          {inputs.length
            ? ` · ${inputs.length} saved revision${inputs.length === 1 ? "" : "s"}`
            : ""}
        </summary>
        <div className="guest-actions-body">
          <p>
            Edited ordinary fields with unique IDs, names or labels can be saved here. Passwords,
            files, sensitive fields, ambiguous identifiers and script state are excluded. HTML
            scripts and network requests remain active.
          </p>
          {!available && (
            <p>The owner is unavailable. Saved input stays here; no source writes are queued.</p>
          )}
          {inputs.map((input) => {
            const same =
              input.ownerDeviceId === record.ownerDeviceId &&
              input.sourceTabId === record.source.sourceTabId &&
              input.revision === artifact.revision &&
              input.blob === artifact.blob;
            return (
              <div key={input.revision}>
                <p>
                  Saved input · owner revision {input.revision}
                  {same
                    ? ""
                    : ` · current revision ${artifact.revision}; copy or discard old input`}
                </p>
                <div className="flex flex-wrap gap-2">
                  {same && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!available || !ready || !loaded}
                      onClick={() => {
                        try {
                          restoreFields(frame.current!, input.fields);
                          setError(
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
                        .writeText(JSON.stringify(input.fields, null, 2))
                        .catch(() =>
                          setError("Could not copy. Select and copy the retained values below."),
                        )
                    }
                  >
                    Copy saved input
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void discard(input)}>
                    Discard saved input
                  </Button>
                </div>
                <textarea
                  aria-label={`Saved input revision ${input.revision}`}
                  readOnly
                  value={JSON.stringify(input.fields, null, 2)}
                  className="w-full"
                  rows={3}
                />
              </div>
            );
          })}
          {(error || save.error) && (
            <p role="alert">{error || "Could not save form input. Keep Scope open and retry."}</p>
          )}
          {save.error && (
            <Button size="sm" onClick={() => void save.flush().catch(() => {})}>
              Retry form save
            </Button>
          )}
        </div>
      </details>
      {children}
    </div>
  );
}
