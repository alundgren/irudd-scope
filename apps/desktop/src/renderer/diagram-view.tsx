import { useEffect, useRef, useState } from "react";
import { Excalidraw, getSceneVersion, loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ArtifactContent } from "../bridge.ts";
import { readSemanticScene, updateCanvasElements } from "../diagram/canvas.ts";
import { applyOperations } from "../diagram/scene.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import "@excalidraw/excalidraw/index.css";

type Draft = { content: string; revision: number; dirty: boolean };
const drafts = new Map<string, Draft>();
export function DiagramView({ item }: { item: ArtifactContent }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const version = useRef(-1);
  const loaded = useRef(item.artifact.revision);
  const [revision, setRevision] = useState(item.artifact.revision);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const latest = useRef(item);
  latest.current = item;

  function markDirty(value: boolean) {
    dirtyRef.current = value;
    setDirty(value);
  }
  async function load(content: string, nextRevision: number, changed = false) {
    if (!api) return;
    setReady(false);
    try {
      const data = await loadFromBlob(
        new Blob([content], { type: "application/vnd.excalidraw+json" }),
        null,
        null,
      );
      version.current = getSceneVersion(data.elements);
      loaded.current = nextRevision;
      setRevision(nextRevision);
      markDirty(changed);
      api.updateScene({
        elements: data.elements,
        appState: { ...data.appState, isLoading: false },
      });
      if (data.files) api.addFiles(Object.values(data.files));
      api.scrollToContent(undefined, { fitToContent: true });
      setReady(true);
    } catch {
      setNotice("Could not open this Excalidraw document. You can still download it.");
    }
  }
  useEffect(() => {
    if (!api) return;
    const draft = drafts.get(item.artifact.id);
    void load(
      draft?.content ?? new TextDecoder().decode(item.bytes),
      draft?.revision ?? item.artifact.revision,
      draft?.dirty ?? false,
    );
    return () => {
      drafts.set(item.artifact.id, {
        content: serializeAsJSON(
          api.getSceneElements(),
          api.getAppState(),
          api.getFiles(),
          "local",
        ),
        revision: loaded.current,
        dirty: dirtyRef.current,
      });
    };
  }, [api, item.artifact.id]);
  useEffect(() => {
    if (api && ready && item.artifact.revision !== loaded.current && !dirtyRef.current)
      void load(new TextDecoder().decode(item.bytes), item.artifact.revision);
  }, [item.artifact.revision, api, ready]);
  async function save(copy = false) {
    if (!api) return;
    setBusy(true);
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
        version.current = getSceneVersion(api.getSceneElements());
        markDirty(false);
        drafts.delete(item.artifact.id);
      }
      setNotice(copy ? "Saved a separate copy. Find it in the artifact list." : "Diagram saved.");
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "Could not save the diagram.");
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    if (!api || !intent.trim()) return;
    setBusy(true);
    const original = api.getSceneElements();
    const originalVersion = getSceneVersion(original);
    try {
      const before = readSemanticScene(original);
      const result = await window.scope.compose({ intent, scene: before });
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
      setNotice(
        `${result.message} ${(metrics.durationMs / 1000).toFixed(1)}s · ${metrics.inputTokens ?? "?"} in / ${metrics.outputTokens ?? "?"} out${metrics.cost === null ? "" : ` · $${metrics.cost.toFixed(5)}`}. Save to publish.`,
      );
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "The diagram request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="diagram-view">
      <div className="diagram-actions">
        <Input
          aria-label="Change diagram"
          placeholder="Describe a change to this diagram…"
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void change();
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !ready || !intent.trim()}
          onClick={() => void change()}
        >
          Apply change
        </Button>
        <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </Button>
        {busy && (
          <Button size="sm" variant="ghost" onClick={() => void window.scope.cancelDrawing()}>
            Cancel
          </Button>
        )}
      </div>
      {item.artifact.revision !== revision && dirty && (
        <div className="diagram-notice">
          A newer version arrived. Your edits are still here.
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void load(
                new TextDecoder().decode(latest.current.bytes),
                latest.current.artifact.revision,
              )
            }
          >
            Discard edits and load latest
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save(true)}>
            Save a copy
          </Button>
        </div>
      )}
      {notice && (
        <div className="diagram-notice" role="status">
          {notice}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss diagram notice"
            onClick={() => setNotice("")}
          >
            ×
          </Button>
        </div>
      )}
      <div className="diagram-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
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
          onChange={(elements) => {
            if (ready) markDirty(getSceneVersion(elements) !== version.current);
          }}
        />
      </div>
    </div>
  );
}
