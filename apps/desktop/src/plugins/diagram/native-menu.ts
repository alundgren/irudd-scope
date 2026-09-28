import { useEffect, useLayoutEffect } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { fitToCanvas } from "./viewport.ts";

export function useDiagramMenu({
  tabId,
  api,
  active,
  ready,
  busy,
  saveCopy,
}: {
  tabId: string;
  api: ExcalidrawImperativeAPI | undefined;
  active: boolean;
  ready: boolean;
  busy: boolean;
  saveCopy: () => Promise<void>;
}) {
  useLayoutEffect(() => {
    if (!active || !ready || !api) return;
    return window.scope.onDiagramMenuAction((command) => {
      if (command.tabId !== tabId) return;
      if (command.action === "fit") fitToCanvas(api);
      else if (!busy) void saveCopy();
    });
  });
  useEffect(() => {
    if (!active) return;
    void window.scope
      .setDiagramMenu({ tabId, canSaveCopy: ready && !busy, canFit: ready })
      .catch(() => {
        api?.setToast({ message: "Could not update the application menu." });
      });
    return () => {
      void window.scope.setDiagramMenu(null).catch(() => {});
    };
  }, [tabId, active, ready, busy]);
}
