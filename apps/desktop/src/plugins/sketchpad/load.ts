import { useEffect, useRef, useState } from "react";
import { loadFromBlob } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Theme } from "../../renderer/appearance.ts";
import type { SketchpadDraft } from "./contract.ts";

// Reads the saved canvas once per tab and reports readiness only after it is on screen.
export function useSketchpadLoad({
  api,
  tabId,
  display,
  beforeLoad,
}: {
  api: ExcalidrawImperativeAPI | undefined;
  tabId: string;
  display: { current: { theme: Theme; viewing: boolean } };
  beforeLoad: (draft: SketchpadDraft | null) => void;
}) {
  const [restored, setRestored] = useState<SketchpadDraft | null>();
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [openError, setOpenError] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  useEffect(() => {
    let current = true;
    setRestoreError(false);
    void window.scope
      .sketchpadDraft(tabId)
      .then((draft) => {
        if (current) setRestored(draft);
      })
      .catch(() => {
        if (current) setRestoreError(true);
      });
    return () => {
      current = false;
    };
  }, [tabId, restoreAttempt]);

  useEffect(() => {
    if (!api || restored === undefined) return;
    let current = true;
    async function load(draft: SketchpadDraft | null) {
      if (!api) return;
      beforeLoad(draft);
      if (draft) {
        const data = await loadFromBlob(
          new Blob([draft.content], { type: "application/vnd.excalidraw+json" }),
          null,
          null,
        );
        if (!current) return;
        const viewport = draft.viewport;
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
      }
      if (!current) return;
      readyRef.current = true;
      setReady(true);
    }
    // A saved canvas that cannot open stays stored; editing stays off so nothing overwrites it.
    load(restored).catch(() => {
      if (current) setOpenError(true);
    });
    return () => {
      current = false;
    };
  }, [api, restored]);

  return {
    restored,
    restoreError,
    retry: () => setRestoreAttempt((value) => value + 1),
    openError,
    ready,
    readyRef,
  };
}
