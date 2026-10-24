import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { GuestRecord } from "./contract.ts";
import type { GuestField, GuestInput } from "./recovery-contract.ts";
import { captureField, recoverableFields, restoreFields } from "./html-fields.ts";
import { useAutosave } from "../workspace/persistence.ts";
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
  const captureErrors = useRef(new Map<string, string>());
  const initialRead = useRef<Promise<void> | undefined>(undefined);
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
      await initialRead.current;
      value = { ...value, fields: [...fields.current.values()] };
      if (captureErrors.current.size) throw new Error([...captureErrors.current.values()][0]);
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
    initialRead.current = window.scope.guestRecovery(record.tab.id).then((recovery) => {
      const inputs = recovery.inputs.filter((input) => input.kind === "html");
      if (live) {
        setInputs(inputs);
        setLoaded(true);
      }
      const saved = inputs.find(
        (input) => input.revision === artifact.revision && input.blob === artifact.blob,
      );
      for (const field of saved?.fields ?? [])
        if (!fields.current.has(field.key)) fields.current.set(field.key, field);
    });
    void initialRead.current.catch(() => {
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
      const related =
        found[1].tagName === "INPUT" && found[1].type === "radio"
          ? [...supported].filter(
              ([, field]) =>
                field.type === "radio" &&
                field.name === found[1].name &&
                field.form === found[1].form,
            )
          : [found];
      for (const [key, field] of related) {
        try {
          if (!fields.current.has(key) && fields.current.size >= 64) {
            if (field.value === "") {
              captureErrors.current.delete(key);
              continue;
            }
            throw new Error(
              "More than 64 edited fields cannot be saved. Copy your input before closing.",
            );
          }
          fields.current.set(key, captureField(key, field));
          captureErrors.current.delete(key);
        } catch (error) {
          captureErrors.current.set(
            key,
            error instanceof Error ? error.message : "Could not capture input.",
          );
        }
      }
      setError([...captureErrors.current.values()][0] ?? "");
      save.schedule();
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
        captureErrors.current.clear();
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
            Scope saves supported fields with unique names or labels. Passwords, files, sensitive
            fields and script state are excluded. HTML can still run scripts and make network
            requests.
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
                        .writeText(inputText(input))
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
                <details>
                  <summary>View saved values</summary>
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
