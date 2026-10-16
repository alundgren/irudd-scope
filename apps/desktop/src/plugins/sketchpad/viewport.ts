import { useEffect, useRef } from "react";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SketchpadViewport } from "./contract.ts";

export function fitToCanvas(api: ExcalidrawImperativeAPI): boolean {
  const state = api.getAppState();
  const elements = api.getSceneElements();
  if (state.isLoading || !state.width || !state.height || !elements.length) return false;
  api.scrollToContent(elements, { fitToContent: true, viewportZoomFactor: 0.9, animate: false });
  return true;
}

export function useSketchpadViewport(
  api: ExcalidrawImperativeAPI | undefined,
  active: boolean,
  ready: boolean,
  initial?: SketchpadViewport,
) {
  const current = useRef(initial);
  const pendingFit = useRef(!initial);
  function observe(state?: AppState) {
    if (!api || !active || !ready) return;
    state ??= api.getAppState();
    if (state.isLoading || !state.width || !state.height) return;
    if (pendingFit.current) {
      pendingFit.current = false;
      // A hidden tab has no usable canvas dimensions. Record the viewport after the fit commits.
      if (fitToCanvas(api)) return;
    }
    current.current = { zoom: state.zoom.value, scrollX: state.scrollX, scrollY: state.scrollY };
  }
  useEffect(() => observe(), [api, active, ready]);
  return {
    read: () => current.current,
    observe,
    restore: (viewport?: SketchpadViewport) => {
      current.current = viewport;
      pendingFit.current = !viewport;
    },
    requestFit: () => {
      current.current = undefined;
      pendingFit.current = true;
    },
  };
}
