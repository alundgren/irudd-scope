import { useRef } from "react";
import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

// Serializing images is costly, so reuse the last result until the scene changes.
export function useSceneContent() {
  const cached = useRef<{ key: string; files: unknown; content: string } | null>(null);
  return {
    read(api: ExcalidrawImperativeAPI) {
      const elements = api.getSceneElements();
      const state = api.getAppState();
      const files = api.getFiles();
      // Version totals can collide after undo and editing a different object.
      const key = JSON.stringify([
        elements.map(({ id, version, versionNonce }) => [id, version, versionNonce]),
        state.viewBackgroundColor,
        state.gridSize,
        state.gridStep,
        state.gridModeEnabled,
      ]);
      if (cached.current?.key !== key || cached.current.files !== files)
        cached.current = {
          key,
          files,
          // Local serialization drops deleted elements and images no element uses.
          content: serializeAsJSON(elements, state, files, "local"),
        };
      return cached.current.content;
    },
    clear() {
      cached.current = null;
    },
  };
}
