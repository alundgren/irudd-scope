import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Schema } from "effect";
import type { TabContext } from "../api.ts";
import type { Tab } from "../../workspace/contract.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Board, defaultCamera } from "./board.tsx";
import {
  CanvasTabState,
  canvasTabState,
  type CanvasCamera,
  type CanvasWriteResult,
} from "./contract.ts";
import { useCanvas } from "./use-canvas.ts";
import "./style.css";

function savedState(tab: Tab): CanvasTabState {
  try {
    return Schema.decodeUnknownSync(CanvasTabState)(tab.state);
  } catch {
    return canvasTabState();
  }
}

export function CanvasView({
  tab,
  context,
  active,
  viewing,
}: {
  tab: Tab;
  context: TabContext;
  active: boolean;
  viewing: boolean;
}) {
  const [notice, setNotice] = useState("");
  const canvas = useCanvas(context.tabId, setNotice);
  const state = useRef(savedState(tab));
  const [camera, setCamera] = useState<CanvasCamera>(state.current.data.camera ?? defaultCamera);
  const saveCamera = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The camera is tab state, not content, so moving around never enters history.
  const moveCamera = useCallback(
    (next: CanvasCamera) => {
      setCamera(next);
      clearTimeout(saveCamera.current);
      saveCamera.current = setTimeout(() => {
        state.current = { ...state.current, data: { ...state.current.data, camera: next } };
        context.updateState(state.current);
      }, 250);
    },
    [context],
  );

  useEffect(
    () =>
      context.onBeforeClose(async () => {
        if (saveCamera.current) {
          clearTimeout(saveCamera.current);
          context.updateState({
            ...state.current,
            data: { ...state.current.data, camera },
          });
        }
        await canvas.flush();
      }),
    [canvas.flush, camera],
  );

  const step = useCallback(
    (direction: "undo" | "redo") =>
      void canvas.step({ board: true }, direction).then((result: CanvasWriteResult) => {
        if (!result.ok || !result.kept.length) return;
        const titles = result.kept.map(
          (kept) => canvas.snapshot?.board.cards[kept.id]?.title ?? "a card",
        );
        setNotice(`Kept ${[...new Set(titles)].join(", ")} as it is now.`);
      }),
    [canvas.step, canvas.snapshot],
  );

  if (!canvas.snapshot)
    return (
      <div className="content-notice" role={canvas.loadError ? "alert" : "status"}>
        {canvas.loadError ? (
          <>
            <span>Could not open this canvas.</span>
            <Button size="sm" onClick={() => void canvas.reload()}>
              Retry
            </Button>
          </>
        ) : (
          "Opening canvas…"
        )}
      </div>
    );
  return (
    <div className="canvas-view">
      {notice && (
        <div className="content-notice" role="status">
          <span>{notice}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss canvas notice"
            onClick={() => setNotice("")}
          >
            <X />
          </Button>
        </div>
      )}
      <Board
        name={tab.title}
        onRename={context.rename}
        snapshot={canvas.snapshot}
        camera={camera}
        editable={!viewing}
        active={active}
        onCamera={moveCamera}
        write={canvas.write}
        step={step}
      />
    </div>
  );
}
