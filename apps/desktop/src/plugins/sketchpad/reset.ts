import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const RESET_UNDO_MS = 10_000;
type PendingReset = {
  ids: ReadonlySet<string>;
  background: string;
  timer: ReturnType<typeof setTimeout>;
};

// Reset clears the canvas at once but keeps saved content until the undo window ends.
export function useCanvasReset(api: ExcalidrawImperativeAPI | undefined, settled: () => void) {
  const pending = useRef<PendingReset | null>(null);
  const [resetting, setResetting] = useState(false);
  function finish(restore: boolean) {
    const current = pending.current;
    if (!current) return;
    clearTimeout(current.timer);
    pending.current = null;
    setResetting(false);
    if (restore && api)
      api.updateScene({
        elements: api
          .getSceneElementsIncludingDeleted()
          .map((element) =>
            current.ids.has(element.id) ? newElementWith(element, { isDeleted: false }) : element,
          ),
        appState: { viewBackgroundColor: current.background },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    settled();
  }
  function reset() {
    if (!api || pending.current) return;
    const elements = api.getSceneElements();
    if (!elements.length) return;
    const background = api.getAppState().viewBackgroundColor;
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((element) => newElementWith(element, { isDeleted: true })),
      appState: { viewBackgroundColor: "#ffffff" },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    pending.current = {
      ids: new Set(elements.map((element) => element.id)),
      background,
      timer: setTimeout(() => finish(false), RESET_UNDO_MS),
    };
    setResetting(true);
  }
  useEffect(() => () => clearTimeout(pending.current?.timer), []);
  useEffect(() => {
    if (!resetting) return;
    // Excalidraw's history can be empty after loading, so the undo shortcut restores directly.
    const undo = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener("keydown", undo, true);
    return () => window.removeEventListener("keydown", undo, true);
  }, [resetting]);
  return { resetting, isPending: () => pending.current !== null, reset, finish };
}
