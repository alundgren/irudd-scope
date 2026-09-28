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
import { readDiagramContext, updateCanvasElements } from "./canvas.ts";
import { parseScene } from "./contract.ts";
import { registerDiagramCommands } from "./command-renderer.ts";
import type { DiagramSnapshot } from "@irudd-scope/protocol/diagram";
import { exportToBlob, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { applyOperations } from "./scene.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { DiagramChat } from "./chat.tsx";
import { ProposalPreview } from "./proposal.tsx";
import { DiagramHistory } from "./sync-history.ts";
import {
  applyDiagramDelta,
  diagramDelta,
  parseNativeDiagram,
  type DiagramSyncCommand,
  type DiagramSyncReply,
  type DiagramProposal,
} from "@irudd-scope/protocol/diagram-sync";
import type { DiagramEvent } from "@irudd-scope/protocol";
import { BookOpen, ImageDown, MessageSquare, X } from "lucide-react";
import type { Theme } from "../../renderer/appearance.ts";
import type { DiagramDraft } from "./draft.ts";
import { useAutosave } from "../../workspace/persistence.ts";
import { SettingsContext } from "../../renderer/settings-context.tsx";
import "@excalidraw/excalidraw/index.css";

type AutosaveSnapshot = {
  draft: DiagramDraft;
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
  const publishedContent = useRef<string | null>(null);
  const loaded = useRef(item.artifact.revision);
  const loadId = useRef(0);
  const [revision, setRevision] = useState(item.artifact.revision);
  const [busy, setBusy] = useState<"generation" | "saving" | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [publishing, setPublishing] = useState(false);
  const [intent, setIntent] = useState("");
  const [messages, setMessages] = useState<DiagramDraft["messages"]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [proposal, setProposal] = useState<DiagramProposal>();
  const [proposalViewport, setProposalViewport] = useState<DiagramDraft["viewport"]>();
  const proposalRef = useRef(proposal);
  const [conversationTarget, setConversationTarget] = useState<"external" | "embedded">(
    item.artifact.name ? "external" : "embedded",
  );
  const history = useRef(new DiagramHistory());
  const agentContent = useRef<string | undefined>(undefined);
  const [restored, setRestored] = useState<DiagramDraft | null>();
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const conversation = useRef({
    intent,
    messages,
    chatOpen,
    proposal,
    proposalViewport,
    conversationTarget,
  });
  conversation.current = {
    intent,
    messages,
    chatOpen,
    proposal,
    proposalViewport,
    conversationTarget,
  };
  proposalRef.current = proposal;
  const request = useRef<{ canceled: boolean } | null>(null);
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
      const { proposal, proposalViewport, ...savedConversation } = conversation.current;
      return {
        draft: {
          version: 1,
          content: documentContent(),
          revision: loaded.current,
          dirty: dirtyRef.current,
          ...savedConversation,
          ...(proposal ? { proposal } : {}),
          ...(proposalViewport ? { proposalViewport } : {}),
          viewport: { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY },
        },
        loadId: loadId.current,
      };
    },
    async (snapshot) => {
      if (snapshot.loadId !== loadId.current) return;
      const changed = snapshot.draft.content !== publishedContent.current;
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
        publishedContent.current = draft.content;
        setRevision(saved.revision);
        markDirty(Boolean(api && documentContent() !== draft.content));
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
        if (item.artifact.name && draft.content !== agentContent.current) {
          const current = await history.current.capture(draft.content, context.tabId);
          await emitDiagramEvent("changed", current.version);
        }
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
        setProposal(draft?.proposal);
        setProposalViewport(draft?.proposalViewport);
        setConversationTarget(
          draft?.conversationTarget ?? (item.artifact.name ? "external" : "embedded"),
        );
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
  }, [intent, messages, chatOpen, proposal, proposalViewport, conversationTarget, ready, revision]);

  async function emitDiagramEvent(
    event: DiagramEvent["event"],
    currentVersion: string,
    text?: string,
  ) {
    if (!item.artifact.name) return;
    await window.scope.diagramEvent({
      type: "diagram",
      id: item.artifact.id,
      name: item.artifact.name,
      event,
      version: currentVersion,
      ...(text ? { text } : {}),
    });
  }
  function updateProposal(value: DiagramProposal | undefined) {
    if (value?.id !== proposalRef.current?.id) {
      conversation.current = { ...conversation.current, proposalViewport: undefined };
      setProposalViewport(undefined);
    }
    proposalRef.current = value;
    conversation.current = { ...conversation.current, proposal: value };
    setProposal(value);
    draftSave.schedule();
  }
  async function nativeSnapshot() {
    const content = documentContent();
    const current = await history.current.capture(content, context.tabId);
    if (documentContent() !== content) throw new Error("The canvas changed. Retry the request.");
    return current;
  }
  function requireFinishedEdit() {
    const state = api?.getAppState();
    if (
      state &&
      (state.cursorButton === "down" ||
        state.newElement ||
        state.multiElement ||
        state.editingTextElement ||
        state.editingFrame)
    )
      throw new Error("Finish the current drawing or text edit before applying agent changes.");
  }
  async function applyNative(content: string, expectedVersion: string, signal?: AbortSignal) {
    if (!api) throw new Error("Diagram is still opening.");
    // Excalidraw's import removes unfinished zero-size objects and replaces drag references.
    requireFinishedEdit();
    const data = await loadFromBlob(new Blob([content]), null, null);
    const current = await nativeSnapshot();
    requireFinishedEdit();
    if (current.version !== expectedVersion) return false;
    signal?.throwIfAborted();
    if (latest.current.artifact.revision > loaded.current)
      throw new Error("Resolve the incoming publication in Scope before editing.");
    const previous = new Map(api.getSceneElements().map((element) => [element.id, element]));
    const elements = data.elements.map((element) => {
      const old = previous.get(element.id);
      if (old && JSON.stringify(old) === JSON.stringify(element)) return old;
      return {
        ...element,
        version: Math.max(element.version, old?.version ?? 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      };
    });
    api.updateScene({
      elements,
      appState: {
        viewBackgroundColor: data.appState?.viewBackgroundColor,
        gridSize: data.appState?.gridSize,
        gridStep: data.appState?.gridStep,
        gridModeEnabled: data.appState?.gridModeEnabled,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    if (data.files) api.addFiles(Object.values(data.files));
    serialized.current = null;
    agentContent.current = documentContent();
    markDirty(true);
    draftSave.schedule();
    await draftSave.flush();
    return true;
  }
  async function syncDiagram(
    command: DiagramSyncCommand,
    signal: AbortSignal,
  ): Promise<DiagramSyncReply> {
    if (!item.artifact.name || item.artifact.name !== command.name)
      throw new Error("Two-way editing requires this diagram's unique name.");
    let current = await nativeSnapshot();
    signal.throwIfAborted();
    const receipt = () => ({
      name: command.name,
      version: current.version,
      revision: loaded.current,
    });
    const conflict = (): DiagramSyncReply => ({
      type: "conflict",
      ...receipt(),
      ...("expectedVersion" in command && history.current.since(command.expectedVersion)
        ? { delta: history.current.since(command.expectedVersion)! }
        : {}),
    });
    if (command.action === "read") {
      const delta = command.since ? history.current.since(command.since) : undefined;
      return delta
        ? { type: "delta", ...receipt(), delta }
        : { type: "full", ...receipt(), document: current.document };
    }
    if (command.action === "proposal")
      return { type: "proposal", ...receipt(), proposal: proposalRef.current ?? null };
    if (command.action === "status") return { type: "status", ...receipt() };
    if (command.action === "message") {
      const next = [
        ...conversation.current.messages,
        { role: "assistant" as const, text: command.text, agent: "external" as const },
      ];
      conversation.current = { ...conversation.current, messages: next, chatOpen: true };
      setMessages(next);
      setChatOpen(true);
      await draftSave.flush();
      return { type: "message", ...receipt() };
    }
    if (command.expectedVersion !== current.version) return conflict();
    const next =
      command.action === "replace"
        ? parseNativeDiagram(command.document)
        : applyDiagramDelta(current.document, command.delta);
    if (command.action === "propose") {
      requireFinishedEdit();
      if (proposalRef.current)
        throw new Error(
          "A proposal is awaiting a decision. Read it before proposing another change.",
        );
      const candidate = {
        id: crypto.randomUUID(),
        baseVersion: current.version,
        content: JSON.stringify(next),
        note: command.note,
      };
      updateProposal(candidate);
      await draftSave.flush();
      return { type: "proposal", ...receipt(), proposal: candidate };
    }
    const before = next;
    if (!(await applyNative(JSON.stringify(next), current.version, signal))) {
      current = await nativeSnapshot();
      return conflict();
    }
    current = await nativeSnapshot();
    return { type: "applied", ...receipt(), delta: diagramDelta(before, current.document) };
  }
  async function decideProposal(accept: boolean) {
    const candidate = proposalRef.current;
    if (!candidate) return;
    if (accept && !(await applyNative(candidate.content, candidate.baseVersion)))
      throw new Error(
        "The original diagram changed. Reject this proposal and ask the agent to reconcile it again.",
      );
    updateProposal(undefined);
    await draftSave.flush();
    const current = await nativeSnapshot();
    await emitDiagramEvent(accept ? "accepted" : "rejected", current.version);
  }

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
      publishedContent.current = changed ? null : documentContent();
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
  async function change() {
    if (!api || !intent.trim() || busy || request.current) return;
    if (item.artifact.name && conversationTarget === "external") {
      const prompt = intent.trim().slice(0, 4000);
      try {
        const current = await nativeSnapshot();
        await emitDiagramEvent("message", current.version, prompt);
        setMessages((previous) => [...previous, { role: "user", text: prompt }]);
        setIntent("");
      } catch (failure) {
        setNotice(failure instanceof Error ? failure.message : "Could not send this message.");
      }
      return;
    }
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
      if (busy || request.current || !readyRef.current)
        throw new Error("The diagram is busy. Retry after the current operation finishes.");
      if (command.action === "create") throw new Error("Use the diagram creation command.");
      if (command.action === "sync") return syncDiagram(command.request, combined);
      const current = await snapshot();
      combined.throwIfAborted();
      if ("snapshot" in command && command.snapshot && command.snapshot !== current.snapshot)
        throw new Error("The canvas changed since it was read. Read it again before editing.");
      if (command.action === "apply") {
        requireFinishedEdit();
        if (busyRef.current || request.current || !readyRef.current)
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
  }, [api, ready, busy, item.artifact.id]);
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
        if (event.key === "Escape" && chatOpen && (enabled || item.artifact.name) && !viewing) {
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
          <div
            className="diagram-original"
            inert={Boolean(proposal)}
            aria-hidden={proposal ? true : undefined}
          >
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
              onChange={() => {
                if (readyRef.current) {
                  markDirty(documentContent() !== publishedContent.current);
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
                {(enabled || item.artifact.name) && (
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
          {proposal && (
            <ProposalPreview
              key={proposal.id}
              proposal={proposal}
              theme={theme}
              viewing={viewing}
              viewport={proposalViewport}
              onViewportChange={(viewport) => {
                const previous = conversation.current.proposalViewport;
                if (
                  previous?.zoom === viewport.zoom &&
                  previous.scrollX === viewport.scrollX &&
                  previous.scrollY === viewport.scrollY
                )
                  return;
                conversation.current = { ...conversation.current, proposalViewport: viewport };
                setProposalViewport(viewport);
                draftSave.schedule();
              }}
              onDiscuss={() => {
                setConversationTarget("external");
                setChatOpen(true);
              }}
              onEdit={(content) => {
                if (proposalRef.current) updateProposal({ ...proposalRef.current, content });
              }}
              onAccept={() => decideProposal(true)}
              onReject={() => decideProposal(false)}
            />
          )}
        </div>
        <DiagramChat
          open={chatOpen && (enabled || Boolean(item.artifact.name))}
          name={item.artifact.name}
          target={conversationTarget}
          onTargetChange={setConversationTarget}
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
