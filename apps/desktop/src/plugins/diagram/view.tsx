import type { TabContext } from "../api.ts";
import { useContext, useEffect, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  getSceneVersion,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ArtifactContent } from "../../bridge.ts";
import { readSemanticScene, updateCanvasElements } from "./canvas.ts";
import { applyOperations } from "./scene.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { DiagramChat } from "./chat.tsx";
import { BookOpen, ImageDown, MessageSquare, X } from "lucide-react";
import type { Theme } from "../../renderer/appearance.ts";
import type { DiagramDraft } from "./draft.ts";
import { useAutosave } from "../../workspace/persistence.ts";
import { SettingsContext } from "../../renderer/settings-context.tsx";
import "@excalidraw/excalidraw/index.css";

type DiagramSnapshot = {
  draft: DiagramDraft;
  sceneVersion: number;
  settings: string;
  loadId: number;
};

function canvasSettings(state: Partial<AppState>) {
  return JSON.stringify([
    state.viewBackgroundColor,
    state.gridSize,
    state.gridStep,
    state.gridModeEnabled,
  ]);
}

export function DiagramView({
  item,
  context,
  theme,
  viewing,
}: {
  item: ArtifactContent;
  context: TabContext;
  theme: Theme;
  viewing: boolean;
}) {
  const preferences = useContext(SettingsContext);
  const enabled = preferences?.settings?.diagramGenerationEnabled ?? false;
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const version = useRef(-1);
  const savedSettings = useRef("");
  const loaded = useRef(item.artifact.revision);
  const loadId = useRef(0);
  const [revision, setRevision] = useState(item.artifact.revision);
  const [busy, setBusy] = useState<"generation" | "saving" | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [intent, setIntent] = useState("");
  const [messages, setMessages] = useState<DiagramDraft["messages"]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [restored, setRestored] = useState<DiagramDraft | null>();
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const conversation = useRef({ intent, messages, chatOpen });
  conversation.current = { intent, messages, chatOpen };
  const request = useRef<{ canceled: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const latest = useRef(item);
  latest.current = item;
  const display = useRef({ theme, viewing });
  display.current = { theme, viewing };
  const draftSave = useAutosave<DiagramSnapshot>(
    () => {
      if (!api || !readyRef.current) return undefined;
      const state = api.getAppState();
      return {
        draft: {
          version: 1,
          content: serializeAsJSON(api.getSceneElements(), state, api.getFiles(), "local"),
          revision: loaded.current,
          dirty: dirtyRef.current,
          ...conversation.current,
          viewport: { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY },
        },
        sceneVersion: getSceneVersion(api.getSceneElements()),
        settings: canvasSettings(state),
        loadId: loadId.current,
      };
    },
    async (snapshot) => {
      if (snapshot.loadId !== loadId.current) return;
      const changed =
        snapshot.sceneVersion !== version.current || snapshot.settings !== savedSettings.current;
      const draft = { ...snapshot.draft, revision: loaded.current, dirty: changed };
      await window.scope.saveDiagramDraft(context.tabId, draft);
      if (
        !changed ||
        snapshot.loadId !== loadId.current ||
        latest.current.artifact.revision > loaded.current
      )
        return;
      setPublishing(true);
      try {
        const saved = await window.scope.saveDiagram({
          id: item.artifact.id,
          title: latest.current.artifact.title,
          expectedRevision: loaded.current,
          content: draft.content,
        });
        if (snapshot.loadId !== loadId.current) return;
        loaded.current = saved.revision;
        version.current = snapshot.sceneVersion;
        savedSettings.current = snapshot.settings;
        setRevision(saved.revision);
        markDirty(
          Boolean(
            api &&
            (getSceneVersion(api.getSceneElements()) !== snapshot.sceneVersion ||
              canvasSettings(api.getAppState()) !== snapshot.settings),
          ),
        );
        await window.scope.saveDiagramDraft(context.tabId, {
          ...draft,
          revision: saved.revision,
          dirty: false,
        });
        context.events.emit({
          type: "resource.saved",
          resource: { kind: "artifact", id: saved.id },
          revision: saved.revision,
        });
      } finally {
        setPublishing(false);
      }
    },
    context.tabId,
  );
  useEffect(() => {
    let active = true;
    setRestoreError(false);
    void window.scope
      .diagramDraft(context.tabId)
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
    const currentLoad = ++loadId.current;
    readyRef.current = false;
    setReady(false);
    try {
      const data = await loadFromBlob(
        new Blob([content], { type: "application/vnd.excalidraw+json" }),
        null,
        null,
      );
      if (currentLoad !== loadId.current) return;
      version.current = changed ? -1 : getSceneVersion(data.elements);
      savedSettings.current = canvasSettings(data.appState ?? {});
      loaded.current = nextRevision;
      setRevision(nextRevision);
      markDirty(changed);
      api.updateScene({
        elements: data.elements,
        appState: {
          ...data.appState,
          theme: display.current.theme,
          zenModeEnabled: display.current.viewing,
          viewModeEnabled: display.current.viewing,
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
      // Empty documents have no bounds to fit and can produce an invalid zoom.
      if (!viewport && data.elements.some((element) => !element.isDeleted))
        api.scrollToContent(data.elements, { fitToContent: true });
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
    const content = new TextDecoder().decode(item.bytes);
    const alreadyPublished = draft?.content === content;
    void load(
      draft?.content ?? content,
      alreadyPublished ? item.artifact.revision : (draft?.revision ?? item.artifact.revision),
      !alreadyPublished && (draft?.dirty ?? false),
      restored?.viewport,
    );
    return () => {
      if (request.current) {
        request.current.canceled = true;
        void window.scope.cancelDiagramGeneration().catch(() => {});
      }
    };
  }, [api, item.artifact.id]);
  useEffect(() => {
    if (!api || !ready || item.artifact.revision <= loaded.current) return;
    if (dirtyRef.current) draftSave.schedule();
    else void load(new TextDecoder().decode(item.bytes), item.artifact.revision);
  }, [item.artifact.revision, api, ready, dirty]);
  async function keepBoth() {
    if (!api) return;
    setBusy("saving");
    const savedVersion = getSceneVersion(api.getSceneElements());
    const nextSettings = canvasSettings(api.getAppState());
    try {
      const saved = await window.scope.saveDiagram({
        id: crypto.randomUUID(),
        title: `${item.artifact.title} copy`,
        expectedRevision: 0,
        content: serializeAsJSON(
          api.getSceneElements(),
          api.getAppState(),
          api.getFiles(),
          "local",
        ),
      });
      context.events.emit({
        type: "resource.saved",
        resource: { kind: "artifact", id: saved.id },
        revision: saved.revision,
      });
      if (
        getSceneVersion(api.getSceneElements()) === savedVersion &&
        canvasSettings(api.getAppState()) === nextSettings
      )
        await load(
          new TextDecoder().decode(latest.current.bytes),
          latest.current.artifact.revision,
        );
      setNotice("Kept a separate copy. Find it in the artifact list.");
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
      const result = await window.scope.generateDiagram(
        { intent: prompt, scene: before },
        context.tabId,
      );
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
          details: `${(metrics.durationMs / 1000).toFixed(1)}s · ${metrics.inputTokens ?? "?"} in / ${metrics.outputTokens ?? "?"} out${metrics.cost === null ? "" : ` · $${metrics.cost.toFixed(5)}`}.`,
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
      await window.scope.cancelDiagramGeneration();
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
      className={`diagram-view${viewing ? " diagram-viewing" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && chatOpen && enabled && !viewing) {
          event.stopPropagation();
          setChatOpen(false);
        }
      }}
    >
      {draftSave.error && (
        <div className="diagram-notice" role="alert">
          <span>Could not save this diagram. Keep Scope open and retry.</span>
          <Button size="sm" onClick={() => void draftSave.flush().catch(() => {})}>
            Retry
          </Button>
        </div>
      )}
      {item.artifact.revision > revision && dirty && !publishing && (
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
            Use incoming version
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void keepBoth()}
          >
            Keep both
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
            zenModeEnabled={viewing}
            viewModeEnabled={viewing}
            onLinkOpen={(_element, event) => event.preventDefault()}
            validateEmbeddable={false}
            aiEnabled={false}
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
                    canvasSettings(appState) !== savedSettings.current,
                );
                draftSave.schedule();
              }
            }}
          >
            <MainMenu>
              <MainMenu.Item
                icon={<ImageDown />}
                onSelect={() =>
                  api?.updateScene({ appState: { openDialog: { name: "imageExport" } } })
                }
              >
                Export
              </MainMenu.Item>
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.Item
                icon={<BookOpen />}
                onSelect={() => api?.toggleSidebar({ name: "default", tab: "library" })}
              >
                Library
              </MainMenu.Item>
              {enabled && (
                <MainMenu.Item
                  icon={<MessageSquare />}
                  onSelect={() => setChatOpen((value) => !value)}
                >
                  Ask agent
                </MainMenu.Item>
              )}
            </MainMenu>
          </Excalidraw>
        </div>
        <DiagramChat
          open={chatOpen && enabled}
          focus={viewing}
          messages={messages}
          intent={intent}
          busy={busy}
          ready={ready}
          onClose={() => setChatOpen(false)}
          onIntentChange={setIntent}
          onSend={() => void change()}
          onCancel={() => void cancel()}
        />
      </div>
    </div>
  );
}
