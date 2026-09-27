import { useEffect, useRef, useState } from "react";
import { Excalidraw, getSceneVersion, loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ArtifactContent } from "../bridge.ts";
import { readSemanticScene, updateCanvasElements } from "../diagram/canvas.ts";
import { applyOperations } from "../diagram/scene.ts";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { MessageSquare, X } from "lucide-react";
import type { Theme } from "./appearance.ts";
import type { DiagramDraft } from "../diagram/draft.ts";
import { useAutosave } from "./persistence.ts";
import "@excalidraw/excalidraw/index.css";

function drawingSettings(state: Partial<AppState>) {
  return JSON.stringify([
    state.viewBackgroundColor,
    state.gridSize,
    state.gridStep,
    state.gridModeEnabled,
  ]);
}

export function DiagramView({
  item,
  theme,
  focus,
}: {
  item: ArtifactContent;
  theme: Theme;
  focus: boolean;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const version = useRef(-1);
  const savedSettings = useRef("");
  const loaded = useRef(item.artifact.revision);
  const [revision, setRevision] = useState(item.artifact.revision);
  const [busy, setBusy] = useState<"generation" | "saving" | null>(null);
  const [intent, setIntent] = useState("");
  const [messages, setMessages] = useState<DiagramDraft["messages"]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [restored, setRestored] = useState<DiagramDraft | null>();
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const conversation = useRef({ intent, messages, chatOpen });
  conversation.current = { intent, messages, chatOpen };
  const request = useRef<{ canceled: boolean } | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages, chatOpen, focus]);
  useEffect(() => {
    if (chatOpen && !focus) composer.current?.focus({ preventScroll: true });
  }, [chatOpen, focus]);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const latest = useRef(item);
  latest.current = item;
  const display = useRef({ theme, focus });
  display.current = { theme, focus };
  const draftSave = useAutosave<DiagramDraft>(
    () => {
      if (!api || !readyRef.current) return undefined;
      const state = api.getAppState();
      return {
        version: 1,
        content: serializeAsJSON(api.getSceneElements(), state, api.getFiles(), "local"),
        revision: loaded.current,
        dirty: dirtyRef.current,
        ...conversation.current,
        viewport: { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY },
      };
    },
    (draft) => window.scope.saveDiagramDraft(item.artifact.id, draft),
  );
  useEffect(() => {
    let active = true;
    setRestoreError(false);
    void window.scope
      .diagramDraft(item.artifact.id)
      .then((draft) => {
        if (!active) return;
        setIntent(draft?.intent ?? "");
        setMessages(draft?.messages ?? []);
        setChatOpen(draft?.chatOpen ?? false);
        setRestored(draft);
      })
      .catch(() => {
        if (active) setRestoreError(true);
      });
    return () => {
      active = false;
    };
  }, [item.artifact.id, restoreAttempt]);
  useEffect(() => {
    if (ready) draftSave.schedule();
  }, [intent, messages, chatOpen, ready, revision]);

  function markDirty(value: boolean) {
    dirtyRef.current = value;
    setDirty(value);
  }
  async function load(
    content: string,
    nextRevision: number,
    changed = false,
    viewport?: DiagramDraft["viewport"],
  ) {
    if (!api) return;
    readyRef.current = false;
    setReady(false);
    try {
      const data = await loadFromBlob(
        new Blob([content], { type: "application/vnd.excalidraw+json" }),
        null,
        null,
      );
      version.current = changed ? -1 : getSceneVersion(data.elements);
      savedSettings.current = drawingSettings(data.appState ?? {});
      loaded.current = nextRevision;
      setRevision(nextRevision);
      markDirty(changed);
      api.updateScene({
        elements: data.elements,
        appState: {
          ...data.appState,
          theme: display.current.theme,
          zenModeEnabled: display.current.focus,
          isLoading: false,
          ...(viewport
            ? {
                scrollX: viewport.scrollX,
                scrollY: viewport.scrollY,
                zoom: { value: viewport.zoom } as AppState["zoom"],
              }
            : {}),
        },
      });
      if (data.files) api.addFiles(Object.values(data.files));
      if (!viewport) api.scrollToContent(undefined, { fitToContent: true });
      readyRef.current = true;
      setReady(true);
    } catch {
      setNotice("Could not open this Excalidraw document. You can still download it.");
    }
  }
  useEffect(() => {
    if (!api) return;
    const draft =
      restored && (restored.dirty || restored.revision === item.artifact.revision)
        ? restored
        : null;
    void load(
      draft?.content ?? new TextDecoder().decode(item.bytes),
      draft?.revision ?? item.artifact.revision,
      draft?.dirty ?? false,
      restored?.viewport,
    );
    return () => {
      if (request.current) {
        request.current.canceled = true;
        void window.scope.cancelDrawing().catch(() => {});
      }
    };
  }, [api, item.artifact.id]);
  useEffect(() => {
    if (api && ready && item.artifact.revision !== loaded.current && !dirtyRef.current)
      void load(new TextDecoder().decode(item.bytes), item.artifact.revision);
  }, [item.artifact.revision, api, ready]);
  async function save(copy = false) {
    if (!api) return;
    setBusy("saving");
    const savedVersion = getSceneVersion(api.getSceneElements());
    const nextSettings = drawingSettings(api.getAppState());
    try {
      const saved = await window.scope.saveDiagram({
        id: copy ? crypto.randomUUID() : item.artifact.id,
        title: copy ? `${item.artifact.title} copy` : item.artifact.title,
        expectedRevision: copy ? 0 : loaded.current,
        content: serializeAsJSON(
          api.getSceneElements(),
          api.getAppState(),
          api.getFiles(),
          "local",
        ),
      });
      if (!copy) {
        loaded.current = saved.revision;
        setRevision(saved.revision);
        version.current = savedVersion;
        savedSettings.current = nextSettings;
        markDirty(
          getSceneVersion(api.getSceneElements()) !== savedVersion ||
            drawingSettings(api.getAppState()) !== nextSettings,
        );
        draftSave.schedule();
      }
      setNotice(copy ? "Saved a separate copy. Find it in the artifact list." : "Diagram saved.");
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "Could not save the diagram.");
    } finally {
      setBusy(null);
    }
  }
  async function change() {
    if (!api || !intent.trim() || busy || request.current) return;
    const current = { canceled: false };
    request.current = current;
    setBusy("generation");
    const prompt = intent.trim();
    setMessages((previous) => [...previous, { role: "user", text: prompt }]);
    const original = api.getSceneElements();
    const originalVersion = getSceneVersion(original);
    try {
      const before = readSemanticScene(original);
      const result = await window.scope.compose({ intent: prompt, scene: before });
      if (current.canceled) throw new Error("Request canceled. The canvas is unchanged.");
      if (getSceneVersion(api.getSceneElements()) !== originalVersion)
        throw new Error(
          "The canvas changed during generation. Your edits were kept. Try the request again.",
        );
      api.updateScene({
        elements: updateCanvasElements(
          before,
          applyOperations(before, result.operations),
          api.getSceneElements(),
        ),
      });
      markDirty(true);
      setIntent("");
      const metrics = result.metrics;
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          text: result.message,
          details: `${(metrics.durationMs / 1000).toFixed(1)}s · ${metrics.inputTokens ?? "?"} in / ${metrics.outputTokens ?? "?"} out${metrics.cost === null ? "" : ` · $${metrics.cost.toFixed(5)}`}. Save to publish.`,
        },
      ]);
    } catch (failure) {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          text: current.canceled
            ? "Request canceled. The canvas is unchanged."
            : failure instanceof Error
              ? failure.message
              : "The diagram request failed. Try again.",
        },
      ]);
    } finally {
      if (request.current === current) request.current = null;
      setBusy(null);
    }
  }
  async function cancel() {
    if (!request.current) return;
    request.current.canceled = true;
    try {
      await window.scope.cancelDrawing();
    } catch {
      setNotice("Could not reach the provider to cancel. Its result will not change the canvas.");
    }
  }
  if (restored === undefined)
    return (
      <div className="diagram-notice" role={restoreError ? "alert" : "status"}>
        {restoreError ? (
          <>
            Could not load the saved diagram draft.{" "}
            <Button onClick={() => setRestoreAttempt((value) => value + 1)}>Retry</Button>
          </>
        ) : (
          "Opening diagram…"
        )}
      </div>
    );
  return (
    <div
      className="diagram-view"
      onKeyDown={(event) => {
        if (event.key === "Escape" && chatOpen && !focus) {
          event.stopPropagation();
          setChatOpen(false);
        }
      }}
    >
      {draftSave.error && (
        <div className="diagram-notice" role="alert">
          <span>Could not save this draft on your Mac. Keep Scope open and retry.</span>
          <Button size="sm" onClick={() => void draftSave.flush().catch(() => {})}>
            Retry
          </Button>
        </div>
      )}
      {item.artifact.revision !== revision && dirty && (
        <div className="diagram-notice" role="alert">
          <span>A newer version arrived. Your edits are still here.</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              void load(
                new TextDecoder().decode(latest.current.bytes),
                latest.current.artifact.revision,
              )
            }
          >
            Discard edits and load latest
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void save(true)}
          >
            Save a copy
          </Button>
        </div>
      )}
      {notice && (
        <div className="diagram-notice" role="status">
          <span>{notice}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss diagram notice"
            onClick={() => setNotice("")}
          >
            <X />
          </Button>
        </div>
      )}
      <div className="diagram-body">
        <div className="diagram-canvas">
          <Excalidraw
            excalidrawAPI={setApi}
            theme={theme}
            zenModeEnabled={focus}
            onLinkOpen={(_element, event) => event.preventDefault()}
            validateEmbeddable={false}
            aiEnabled={false}
            renderTopRightUI={() =>
              focus ? null : (
                <div className="diagram-controls">
                  <Button size="sm" disabled={busy !== null || !dirty} onClick={() => void save()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-expanded={chatOpen}
                    onClick={() => setChatOpen((value) => !value)}
                  >
                    <MessageSquare /> Ask agent
                  </Button>
                </div>
              )
            }
            UIOptions={{
              canvasActions: {
                export: false,
                saveToActiveFile: false,
                loadScene: false,
                toggleTheme: false,
              },
            }}
            onChange={(elements, appState) => {
              if (readyRef.current) {
                markDirty(
                  getSceneVersion(elements) !== version.current ||
                    drawingSettings(appState) !== savedSettings.current,
                );
                draftSave.schedule();
              }
            }}
          />
        </div>
        <aside className="diagram-chat" aria-label="Diagram agent" hidden={!chatOpen || focus}>
          <div className="chat-heading">
            <div>
              <h2>Diagram agent</h2>
              <p className="secondary">Gemini 3.8 Flash · OpenRouter</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close diagram chat"
              title="Close diagram chat"
              onClick={() => setChatOpen(false)}
            >
              <X />
            </Button>
          </div>
          <div
            className="chat-history"
            role="log"
            aria-label="Diagram conversation"
            aria-live="polite"
            ref={history}
          >
            {!messages.length && (
              <p className="secondary">
                Describe a change to this diagram. You can edit the result on the canvas, then Save
                to publish.
              </p>
            )}
            {messages.map((message, index) => (
              <div
                className={`chat-message${message.role === "user" ? " from-user" : ""}`}
                key={index}
              >
                <strong>{message.role === "user" ? "You" : "Diagram agent"}</strong>
                <p>{message.text}</p>
                {message.details && <p className="secondary">{message.details}</p>}
              </div>
            ))}
            {busy === "generation" && (
              <p role="status" className="secondary">
                Updating diagram…
              </p>
            )}
          </div>
          <form
            className="chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              void change();
            }}
          >
            <Textarea
              ref={composer}
              aria-label="Change diagram"
              placeholder="Describe a change…"
              value={intent}
              maxLength={16000}
              disabled={busy === "generation"}
              onChange={(event) => setIntent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void change();
                }
              }}
            />
            <div className="chat-actions">
              <span className="secondary">Shift + Enter for a new line</span>
              {busy === "generation" ? (
                <Button type="button" size="sm" variant="secondary" onClick={() => void cancel()}>
                  Cancel
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy !== null || !ready || !intent.trim()}
                >
                  Send
                </Button>
              )}
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
}
