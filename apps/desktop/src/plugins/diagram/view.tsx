import type { DiagramAgentStatus } from "@irudd-scope/protocol/diagram-agent";
import type { TabContext } from "../api.ts";
import { useEffect, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  getSceneVersion,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ArtifactContent } from "../../bridge.ts";
import { readDiagramContext, updateCanvasElements } from "./canvas.ts";
import { parseScene } from "./contract.ts";
import { registerDiagramCommands } from "./command-renderer.ts";
import type { DiagramSnapshot } from "@irudd-scope/protocol/diagram";
import { exportToBlob, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { applyOperations } from "./scene.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { DiagramChat } from "./chat.tsx";
import { BookOpen, ImageDown, MessageSquare, X } from "lucide-react";
import type { Theme } from "../../renderer/appearance.ts";
import type { DiagramDraft } from "./draft.ts";
import { useAutosave } from "../../workspace/persistence.ts";
import "@excalidraw/excalidraw/index.css";

type AutosaveSnapshot = {
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
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const version = useRef(-1);
  const savedSettings = useRef("");
  const loaded = useRef(item.artifact.revision);
  const loadId = useRef(0);
  const [revision, setRevision] = useState(item.artifact.revision);
  const [busy, setBusy] = useState<"generation" | "connected" | "saving" | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [publishing, setPublishing] = useState(false);
  const [intent, setIntent] = useState("");
  const [messages, setMessages] = useState<DiagramDraft["messages"]>([]);
  const [agentTarget, setAgentTarget] = useState<"embedded" | "connected">("embedded");
  const [agentStatus, setAgentStatus] = useState<DiagramAgentStatus>({
    id: item.artifact.id,
    phase: "disconnected",
    name: "",
  });
  useEffect(() => {
    let active = true;
    const receive = (status: DiagramAgentStatus) => {
      if (active && status.id === item.artifact.id) setAgentStatus(status);
    };
    let receivedEvent = false;
    const remove = window.scope.onDiagramAgentStatus((status) => {
      if (status.id === item.artifact.id) {
        receivedEvent = true;
        receive(status);
      }
    });
    void window.scope
      .diagramAgentStatus(item.artifact.id)
      .then((status) => {
        if (!receivedEvent) receive(status);
      })
      .catch(() => {});
    return () => {
      active = false;
      remove();
      void window.scope.cancelDiagramAgent(item.artifact.id).catch(() => {});
    };
  }, [item.artifact.id]);
  const [chatOpen, setChatOpen] = useState(false);
  const [restored, setRestored] = useState<DiagramDraft | null>();
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const conversation = useRef({ intent, messages, chatOpen });
  conversation.current = { intent, messages, chatOpen };
  const request = useRef<{ canceled: boolean; target?: "connected" } | null>(null);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const latest = useRef(item);
  latest.current = item;
  const display = useRef({ theme, viewing });
  display.current = { theme, viewing };
  const serialized = useRef<{
    elements: string;
    settings: string;
    files: unknown;
    content: string;
  } | null>(null);
  function documentContent() {
    if (!api) throw new Error("Diagram is still opening.");
    const elements = api.getSceneElements();
    const state = api.getAppState();
    const files = api.getFiles();
    // Version totals can collide after undo and editing a different object.
    const elementVersions = JSON.stringify(
      elements.map(({ id, version, versionNonce }) => [id, version, versionNonce]),
    );
    const settings = canvasSettings(state);
    if (
      !serialized.current ||
      serialized.current.elements !== elementVersions ||
      serialized.current.settings !== settings ||
      serialized.current.files !== files
    ) {
      serialized.current = {
        elements: elementVersions,
        settings,
        files,
        content: serializeAsJSON(elements, state, files, "local"),
      };
    }
    return serialized.current.content;
  }
  const draftSave = useAutosave<AutosaveSnapshot>(
    () => {
      if (!api || !readyRef.current) return undefined;
      const state = api.getAppState();
      return {
        draft: {
          version: 1,
          content: documentContent(),
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
      serialized.current = null;
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
        content: documentContent(),
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
  async function changeConnected() {
    if (!api || !intent.trim() || busy || request.current || agentStatus.phase !== "waiting")
      return;
    const current = { canceled: false, target: "connected" as const };
    request.current = current;
    setBusy("connected");
    const prompt = intent.trim();
    setMessages((previous) => [...previous, { role: "user", text: prompt }]);
    try {
      const result = await window.scope.requestDiagramAgent({
        id: item.artifact.id,
        intent: prompt,
        history: messages.slice(-12).map(({ role, text }) => ({ role, text: text.slice(0, 4000) })),
      });
      if (!current.canceled) {
        setIntent("");
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            text: result.message,
            details: agentStatus.name,
          },
        ]);
      }
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          text: current.canceled
            ? "Request canceled. Read the canvas before retrying if a reply was already arriving."
            : error instanceof Error
              ? error.message
              : "The connected agent did not reply. Connect again and retry.",
        },
      ]);
    } finally {
      if (request.current === current) request.current = null;
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
      const details = readDiagramContext(original, api.getAppState().selectedElementIds);
      const before = parseScene(details.scene);
      const result = await window.scope.generateDiagram(
        {
          intent: prompt,
          ...details,
          history: messages
            .slice(-12)
            .map(({ role, text }) => ({ role, text: text.slice(0, 4000) })),
        },
        context.tabId,
      );
      if (current.canceled) throw new Error("Request canceled. The canvas is unchanged.");
      if (getSceneVersion(api.getSceneElements()) !== originalVersion)
        throw new Error(
          "The canvas changed during generation. Your edits were kept. Try the request again.",
        );
      api.updateScene({
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
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
  useEffect(() => {
    if (!api || !ready) return;
    const lifetime = new AbortController();
    async function snapshot(): Promise<DiagramSnapshot> {
      const content = documentContent();
      const snapshotRevision = loaded.current;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${snapshotRevision}\n${content}`),
      );
      if (documentContent() !== content || loaded.current !== snapshotRevision)
        throw new Error("The canvas changed. Read it again.");
      return {
        id: item.artifact.id,
        revision: snapshotRevision,
        dirty: dirtyRef.current,
        snapshot: Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
        ...readDiagramContext(api!.getSceneElements(), api!.getAppState().selectedElementIds),
      };
    }
    const unregister = registerDiagramCommands(item.artifact.id, async (command, signal) => {
      const combined = AbortSignal.any([signal, lifetime.signal]);
      if (
        (busyRef.current && busyRef.current !== "connected") ||
        (request.current && request.current.target !== "connected") ||
        !readyRef.current
      )
        throw new Error("The diagram is busy. Retry after the current operation finishes.");
      if (command.action === "create") throw new Error("Use the diagram creation command.");
      const current = await snapshot();
      combined.throwIfAborted();
      if ("snapshot" in command && command.snapshot && command.snapshot !== current.snapshot)
        throw new Error("The canvas changed since it was read. Read it again before editing.");
      if (command.action === "apply") {
        if (
          (busyRef.current && busyRef.current !== "connected") ||
          (request.current && request.current.target !== "connected") ||
          !readyRef.current
        )
          throw new Error(
            "The diagram is busy. Read it again after the current operation finishes.",
          );
        if (latest.current.artifact.revision > loaded.current)
          throw new Error(
            "A newer published revision is waiting. Resolve it in Scope before editing.",
          );
        const before = parseScene(current.scene);
        const elements = updateCanvasElements(
          before,
          applyOperations(before, command.operations),
          api.getSceneElements(),
        );
        combined.throwIfAborted();
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        markDirty(true);
        draftSave.schedule();
        await draftSave.flush();
        setNotice("Agent edits applied.");
        return { type: "snapshot", diagram: await snapshot() };
      }
      if (command.action === "preview") {
        const blob = await exportToBlob({
          elements: api.getSceneElements(),
          appState: { ...api.getAppState(), exportBackground: true },
          files: api.getFiles(),
          mimeType: "image/png",
          maxWidthOrHeight: 2048,
        });
        combined.throwIfAborted();
        if ((await snapshot()).snapshot !== current.snapshot)
          throw new Error("The canvas changed while rendering. Request another preview.");
        if (blob.size > 8 * 1024 * 1024) throw new Error("Preview exceeds 8 MiB.");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return {
          type: "preview",
          id: item.artifact.id,
          revision: current.revision,
          snapshot: current.snapshot,
          mediaType: "image/png",
          data: btoa(binary),
        };
      }
      return { type: "snapshot", diagram: current };
    });
    return () => {
      lifetime.abort();
      unregister();
    };
  }, [api, ready, item.artifact.id]);
  async function cancel() {
    if (!request.current) return;
    request.current.canceled = true;
    try {
      if (request.current.target === "connected")
        await window.scope.cancelDiagramAgent(item.artifact.id);
      else await window.scope.cancelDiagramGeneration();
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
        if (event.key === "Escape" && chatOpen && !viewing) {
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
              <MainMenu.Item
                icon={<MessageSquare />}
                onSelect={() => setChatOpen((value) => !value)}
              >
                Ask agent
              </MainMenu.Item>
            </MainMenu>
          </Excalidraw>
        </div>
        <DiagramChat
          open={chatOpen}
          focus={viewing}
          messages={messages}
          intent={intent}
          busy={busy}
          ready={ready}
          onClose={() => setChatOpen(false)}
          onIntentChange={setIntent}
          target={agentTarget}
          onTargetChange={setAgentTarget}
          agentStatus={agentStatus}
          onSend={() => void (agentTarget === "connected" ? changeConnected() : change())}
          onCancel={() => void cancel()}
        />
      </div>
    </div>
  );
}
