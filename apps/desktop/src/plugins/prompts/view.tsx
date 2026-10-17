import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Copy, MoreHorizontal, RotateCcw, X } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import {
  PROMPT_STRUCTURE,
  PROMPT_FIELDS,
  assemblePrompt,
  emptyPromptDocument,
  type PromptDocument,
  type PromptField,
  type PromptItem,
} from "@irudd-scope/protocol/prompts";
import type { TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Textarea } from "../../renderer/components/ui/textarea.tsx";
import { PromptsTabState } from "./contract.ts";
import { readPromptItem, sanitizePrompt, usePromptEditor } from "./editor.ts";
import { PromptPicker } from "./picker.tsx";
import "./style.css";

export function PromptsView({ context, tab, active }: TabProps) {
  const { document, status, message, libraryEpoch, editor } = usePromptEditor(context);
  const saved = decode(PromptsTabState, tab.state);
  const [divider, setDivider] = useState(saved.data.divider ?? 0.67);
  const [picker, setPicker] = useState<PromptField>();
  const [focused, setFocused] = useState<PromptField>();
  const [hovered, setHovered] = useState<PromptField>();
  const highlight = hovered ?? focused;
  const [items, setItems] = useState<Partial<Record<PromptField, PromptItem>>>({});
  const [itemError, setItemError] = useState("");
  const [itemRetry, setItemRetry] = useState(0);
  const [undo, setUndo] = useState<{ document: PromptDocument; message: string }>();
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const split = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<{ element: HTMLElement; start?: number; end?: number }>(undefined);
  const documentRef = useRef(document);
  documentRef.current = document;
  const selections = document
    ? PROMPT_FIELDS.map((field) => document.parts[field].itemId).join(",")
    : "";
  useEffect(() => {
    let valid = true;
    setItemError("");
    const current = documentRef.current;
    if (!current) return;
    void Promise.all(
      PROMPT_FIELDS.map(async (field) => {
        const id = current.parts[field].itemId;
        if (!id) return [field, undefined] as const;
        try {
          return [field, await readPromptItem(id)] as const;
        } catch (cause) {
          return [field, undefined, cause] as const;
        }
      }),
    ).then((results) => {
      if (!valid) return;
      setItems(Object.fromEntries(results.map(([field, item]) => [field, item])));
      if (results.some((result) => result[2]))
        setItemError("Some selected library items are unavailable. Your copied text is kept.");
    });
    return () => {
      valid = false;
    };
  }, [selections, libraryEpoch, itemRetry]);
  useEffect(() => {
    if (!active) {
      setPicker(undefined);
      setMenu(false);
    }
  }, [active]);
  function adjust(value: number) {
    const next = Math.min(0.85, Math.max(0.4, value));
    setDivider(next);
    context.updateState({ version: 1, data: { divider: next } });
  }
  function openPicker(field: PromptField) {
    const element = window.document.activeElement;
    if (element instanceof HTMLElement)
      returnFocus.current = {
        element,
        ...(element instanceof HTMLTextAreaElement && {
          start: element.selectionStart,
          end: element.selectionEnd,
        }),
      };
    setPicker(field);
  }
  function closePicker() {
    setPicker(undefined);
    const savedFocus = returnFocus.current;
    requestAnimationFrame(() => {
      if (!savedFocus?.element.isConnected) return;
      savedFocus.element.focus({ preventScroll: true });
      if (savedFocus.element instanceof HTMLTextAreaElement && savedFocus.start !== undefined)
        savedFocus.element.setSelectionRange(savedFocus.start, savedFocus.end ?? savedFocus.start);
    });
  }
  function replace(next: PromptDocument, text: string) {
    const previous = documentRef.current;
    if (!previous) return;
    setUndo({ document: structuredClone(previous), message: text });
    setNotice("");
    editor.edit(next);
  }
  async function restore(field: PromptField) {
    const before = documentRef.current;
    const id = before?.parts[field].itemId;
    if (!before || !id) return;
    setBusy(true);
    try {
      const item = await readPromptItem(id);
      if (documentRef.current !== before)
        throw new Error("The field changed while loading. Restore again to replace it.");
      replace(
        {
          ...before,
          parts: { ...before.parts, [field]: { itemId: item.id, text: item.fragment } },
        },
        "Original library text restored.",
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not restore this field. Retry.");
    } finally {
      setBusy(false);
    }
  }
  async function undoChange() {
    if (!undo || busy) return;
    const before = documentRef.current;
    setBusy(true);
    try {
      const recovered = await sanitizePrompt(undo.document);
      if (documentRef.current !== before)
        throw new Error("Text changed during undo. Try Undo again.");
      editor.edit(recovered);
      setUndo(undefined);
      setNotice("");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not undo. Retry.");
    } finally {
      setBusy(false);
    }
  }
  const rendered = document ? assemblePrompt(document) : "";
  const words = rendered.match(/\S+/g)?.length ?? 0;
  return (
    <div className="prompts-view" aria-label="Prompt editor">
      <div className="prompts-layout">
        <header className="prompts-toolbar">
          <span>Text → image</span>
          <span className="prompt-save-state" role="status">
            {status === "saving"
              ? "Saving…"
              : status === "editing"
                ? "Unsaved edits"
                : status === "saved"
                  ? "Saved"
                  : status === "loading"
                    ? "Loading…"
                    : "Edits kept locally"}
          </span>
          <div className="prompts-toolbar-actions">
            <Button
              variant="outline"
              disabled={
                !document ||
                busy ||
                !PROMPT_FIELDS.some(
                  (field) => document.parts[field].text || document.parts[field].itemId,
                )
              }
              onClick={() => replace(emptyPromptDocument(), "Current prompt cleared.")}
            >
              Reset
            </Button>
            <div className="prompt-menu-anchor">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Prompt actions"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              >
                <MoreHorizontal />
              </Button>
              {menu && (
                <div
                  className="prompt-menu"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setMenu(false);
                    }
                  }}
                >
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      setMenu(false);
                      setBusy(true);
                      try {
                        if (await window.scope.exportPromptLibrary())
                          setNotice("Prompt library exported.");
                      } catch (cause) {
                        setNotice(
                          cause instanceof Error
                            ? cause.message
                            : "Export failed. Retry from Prompt actions.",
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Export library ZIP
                  </Button>
                </div>
              )}
            </div>
          </div>
        </header>
        {(status === "error" || status === "conflict") && (
          <div className="prompt-notice" role="alert">
            <p>{message}</p>
            {status === "conflict" ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await editor.keepEdits();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Keep my edits
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (document)
                      setUndo({
                        document: structuredClone(document),
                        message: "Saved prompt loaded.",
                      });
                    setBusy(true);
                    try {
                      await editor.useSaved();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Use saved prompt
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() =>
                  void (
                    document ? editor.flush().then(() => editor.refresh()) : editor.load()
                  ).catch(() => {})
                }
              >
                Retry
              </Button>
            )}
            {document && (
              <Button
                variant="ghost"
                onClick={() =>
                  void window.scope
                    .copyPrompt(rendered)
                    .catch(() => setNotice("Could not copy your edits. Retry."))
                }
              >
                Copy my text
              </Button>
            )}
          </div>
        )}
        {(undo || notice) && (
          <div className="prompt-notice" role="status">
            <p>{notice || undo?.message}</p>
            {undo && (
              <Button variant="outline" disabled={busy} onClick={() => void undoChange()}>
                Undo
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss prompt notice"
              onClick={() => {
                setUndo(undefined);
                setNotice("");
              }}
            >
              <X />
            </Button>
          </div>
        )}
        {itemError && (
          <div className="prompt-notice" role="status">
            <p>{itemError}</p>
            <Button variant="ghost" onClick={() => setItemRetry(itemRetry + 1)}>
              Retry library items
            </Button>
          </div>
        )}
        <div
          ref={split}
          className="prompt-split"
          style={{ "--prompt-divider": `${divider * 100}%` } as CSSProperties}
        >
          <div className="prompt-fields">
            {PROMPT_STRUCTURE.fields.map((field) => {
              const part = document?.parts[field.id];
              const item = items[field.id];
              const edited = !!item && part?.text !== item.fragment;
              return (
                <section
                  className={`prompt-field prompt-field-${field.id}`}
                  key={field.id}
                  onMouseEnter={() => setHovered(field.id)}
                  onMouseLeave={() => setHovered(undefined)}
                  onFocus={() => setFocused(field.id)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
                  }}
                >
                  <div className="prompt-field-heading">
                    <Button
                      variant="outline"
                      aria-label={`Choose ${field.name}`}
                      disabled={!document}
                      onClick={() => openPicker(field.id)}
                    >
                      {field.name}
                      <ChevronDown size={14} />
                    </Button>
                    <div className="prompt-field-actions">
                      {part?.itemId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Restore current library text"
                          aria-label={`Restore ${field.name}`}
                          disabled={busy}
                          onClick={() => void restore(field.id)}
                        >
                          <RotateCcw />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Clear ${field.name}`}
                        disabled={!part || (!part.text && !part.itemId)}
                        onClick={() =>
                          document &&
                          replace(
                            {
                              ...document,
                              parts: { ...document.parts, [field.id]: { text: "", itemId: null } },
                            },
                            `${field.name} cleared.`,
                          )
                        }
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                  <div className="prompt-field-selection" title={item?.name}>
                    {item ? (
                      <>
                        {item.name}
                        {edited && <span> · Edited</span>}
                      </>
                    ) : part?.itemId ? (
                      "Library item unavailable"
                    ) : (
                      ""
                    )}
                  </div>
                  <Textarea
                    aria-label={field.name}
                    value={part?.text ?? ""}
                    disabled={!document}
                    maxLength={8192}
                    spellCheck
                    onChange={(event) => editor.editField(field.id, event.target.value)}
                  />
                </section>
              );
            })}
          </div>
          <div
            className="prompt-divider"
            role="separator"
            aria-label="Editor and combined prompt divider"
            aria-orientation="horizontal"
            aria-valuemin={40}
            aria-valuemax={85}
            aria-valuenow={Math.round(divider * 100)}
            tabIndex={0}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.focus();
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || !split.current) return;
              const rect = split.current.getBoundingClientRect();
              adjust((event.clientY - rect.top) / rect.height);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.02;
              const next =
                event.key === "ArrowUp"
                  ? divider - step
                  : event.key === "ArrowDown"
                    ? divider + step
                    : event.key === "Home"
                      ? 0.67
                      : event.key === "End"
                        ? 0.85
                        : undefined;
              if (next !== undefined) {
                event.preventDefault();
                adjust(next);
              }
            }}
          >
            <span />
          </div>
          <section className="prompt-output" aria-label="Combined prompt">
            <header>
              <span>
                Prompt{" "}
                <small>
                  {words} {words === 1 ? "word" : "words"}
                </small>
              </span>
              <Button
                disabled={!rendered}
                onClick={async () => {
                  try {
                    await window.scope.copyPrompt(rendered);
                    setNotice("Prompt copied.");
                  } catch {
                    setNotice("Could not copy the prompt. Retry.");
                  }
                }}
              >
                <Copy />
                Copy prompt
              </Button>
            </header>
            <div className="prompt-output-text" tabIndex={0} aria-label="Assembled prompt">
              {document &&
                PROMPT_FIELDS.map((field) => {
                  const empty = emptyPromptDocument();
                  const single = {
                    ...empty,
                    parts: { ...empty.parts, [field]: document.parts[field] },
                  };
                  const sentence = assemblePrompt(single);
                  return sentence ? (
                    <span
                      key={field}
                      data-field={field}
                      data-highlighted={highlight === field || undefined}
                    >
                      {sentence}{" "}
                    </span>
                  ) : null;
                })}
            </div>
          </section>
        </div>
      </div>
      {picker && document && (
        <PromptPicker
          field={picker}
          epoch={libraryEpoch}
          selectedId={document.parts[picker].itemId}
          onClose={closePicker}
          onSelect={(item) => {
            const current = documentRef.current;
            if (!current) return;
            replace(
              {
                ...current,
                parts: { ...current.parts, [picker]: { itemId: item.id, text: item.fragment } },
              },
              `${PROMPT_STRUCTURE.fields.find((field) => field.id === picker)!.name} replaced.`,
            );
            closePicker();
          }}
        />
      )}
    </div>
  );
}
