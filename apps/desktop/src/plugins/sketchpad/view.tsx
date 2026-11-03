import { useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { X } from "lucide-react";
import type { TabContext } from "../api.ts";
import type { Theme } from "../../renderer/appearance.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useAutosave } from "../../workspace/persistence.ts";
import { MAX_SKETCHPAD_BYTES, type SketchpadDraft } from "./contract.ts";
import { useSceneContent } from "./content.ts";
import { useSketchpadLoad } from "./load.ts";
import { SketchpadMenu } from "./menu.tsx";
import { useSketchpadMenu } from "./native-menu.ts";
import { useCanvasReset } from "./reset.ts";
import { useSketchpadViewport } from "./viewport.ts";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

type Saved = { kind: "empty" } | { kind: "draft"; draft: SketchpadDraft };

export function SketchpadView({
  context,
  theme,
  viewing,
  active,
}: {
  context: TabContext;
  theme: Theme;
  viewing: boolean;
  active: boolean;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const [notice, setNotice] = useState("");
  const display = useRef({ theme, viewing });
  display.current = { theme, viewing };
  const content = useSceneContent();
  const canvasReset = useCanvasReset(api, active, () => draftSave.schedule());
  const loading = useSketchpadLoad({
    api,
    tabId: context.tabId,
    display,
    beforeLoad: (draft) => {
      content.clear();
      canvasViewport.restore(draft?.viewport);
    },
  });
  const { ready, readyRef } = loading;
  const canvasViewport = useSketchpadViewport(api, active, ready);
  useSketchpadMenu({ tabId: context.tabId, api, active, ready });

  const draftSave = useAutosave<Saved>(
    () => {
      // Never write before the saved canvas loads, or an empty first render would delete it.
      if (!api || !readyRef.current || canvasReset.isPending()) return undefined;
      if (!api.getSceneElements().length) return { kind: "empty" };
      const viewport = canvasViewport.read();
      return {
        kind: "draft",
        draft: { version: 1, content: content.read(api), ...(viewport ? { viewport } : {}) },
      };
    },
    async (value) => {
      if (value.kind === "empty") return window.scope.deleteSketchpadDraft(context.tabId);
      if (new TextEncoder().encode(value.draft.content).length > MAX_SKETCHPAD_BYTES) {
        setNotice("The Sketchpad is over 32 MiB and cannot be saved. Remove an image.");
        throw new Error("The Sketchpad is too large to save.");
      }
      await window.scope.saveSketchpadDraft(context.tabId, value.draft);
    },
    context.tabId,
  );

  useEffect(
    () =>
      context.onBeforeClose(async (purpose) => {
        // Closing or quitting during the undo window keeps the reset the person asked for.
        if (purpose === "close") canvasReset.finish(false);
        await draftSave.flush();
      }),
    [api],
  );

  if (loading.restored === undefined)
    return (
      <div className="content-notice" role={loading.restoreError ? "alert" : "status"}>
        {loading.restoreError ? (
          <>
            Could not load the Sketchpad. <Button onClick={loading.retry}>Retry</Button>
          </>
        ) : (
          "Opening Sketchpad…"
        )}
      </div>
    );
  if (loading.openError)
    return (
      <div className="content-notice" role="alert">
        Could not open the saved Sketchpad. Its content is kept unchanged.
      </div>
    );
  return (
    <div className={`sketchpad-view${viewing ? " sketchpad-viewing" : ""}`}>
      {draftSave.error && (
        <div className="content-notice" role="alert">
          <span>Could not save the Sketchpad. Keep Scope open and retry.</span>
          <Button size="sm" onClick={() => void draftSave.flush().catch(() => {})}>
            Retry
          </Button>
        </div>
      )}
      {canvasReset.resetting && (
        <div className="content-notice" role="status">
          <span>Canvas cleared.</span>
          <Button size="sm" variant="secondary" onClick={() => canvasReset.finish(true)}>
            Undo
          </Button>
        </div>
      )}
      {notice && (
        <div className="content-notice" role="status">
          <span>{notice}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss Sketchpad notice"
            onClick={() => setNotice("")}
          >
            <X />
          </Button>
        </div>
      )}
      <div className="sketchpad-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          theme={theme}
          zenModeEnabled={viewing}
          viewModeEnabled={viewing}
          onLinkOpen={(_element, event) => event.preventDefault()}
          validateEmbeddable={false}
          aiEnabled={false}
          UIOptions={{ canvasActions: { clearCanvas: false, toggleTheme: false } }}
          onChange={(_elements, state) => {
            if (!readyRef.current || !api) return;
            canvasViewport.observe(state);
            // Native undo, new drawing, or an opened file ends the undo window and saves the canvas.
            if (canvasReset.isPending() && api.getSceneElements().length) canvasReset.finish(false);
            draftSave.schedule();
          }}
        >
          <SketchpadMenu
            api={api}
            ready={ready}
            onReset={() => readyRef.current && canvasReset.reset()}
          />
        </Excalidraw>
      </div>
    </div>
  );
}
