import { useEffect, useLayoutEffect } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { fitToCanvas } from "./viewport.ts";

export function useSketchpadMenu({
  tabId,
  api,
  active,
  ready,
}: {
  tabId: string;
  api: ExcalidrawImperativeAPI | undefined;
  active: boolean;
  ready: boolean;
}) {
  useLayoutEffect(() => {
    if (!active || !ready || !api) return;
    return window.scope.onSketchpadMenuAction((command) => {
      if (command.tabId === tabId && command.action === "fit") fitToCanvas(api);
    });
  });
  useEffect(() => {
    if (!active) return;
    void window.scope.setSketchpadMenu({ tabId, canFit: ready }).catch(() => {
      api?.setToast({ message: "Could not update the application menu." });
    });
    return () => {
      void window.scope.setSketchpadMenu(null).catch(() => {});
    };
  }, [tabId, active, ready]);
}
