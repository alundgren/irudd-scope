import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Schema } from "effect";
import type { TabContext } from "../api.ts";
import type { Tab } from "../../workspace/contract.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Board, defaultCamera } from "./board.tsx";
import { CardEditor, useIdPool } from "./card-editor.tsx";
import {
  CanvasTabState,
  canvasTabState,
  type CanvasCamera,
  type CanvasTarget,
  type CanvasWriteResult,
} from "./contract.ts";
import { useCanvas } from "./use-canvas.ts";
import "./style.css";

const EDITOR_CAMERA: CanvasCamera = { x: -80, y: -80, zoom: 1 };

function savedState(tab: Tab): CanvasTabState {
  try {
    return Schema.decodeUnknownSync(CanvasTabState)(tab.state);
  } catch {
    return canvasTabState();
  }
}

/** Tab state the view saves itself: the cameras and which card is open. */
function useViewState(tab: Tab, context: TabContext) {
  const state = useRef(savedState(tab));
  const [data, setData] = useState(state.current.data);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const save = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    context.updateState(state.current);
  }, [context]);
  // Cameras are tab state, not content, so moving around never enters history.
  const update = useCallback(
    (change: (data: CanvasTabState["data"]) => CanvasTabState["data"], now = false) => {
      state.current = { ...state.current, data: change(state.current.data) };
      setData(state.current.data);
      if (now) return save();
      clearTimeout(timer.current);
      timer.current = setTimeout(save, 250);
    },
    [save],
  );
  const flush = useCallback(() => {
    if (timer.current) save();
  }, [save]);
  return { data, update, flush };
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
  const { data, update, flush } = useViewState(tab, context);
  const newId = useIdPool(context.tabId);
  const open = data.open;
  const openCard = open && canvas.snapshot?.cards[open] && canvas.snapshot.board.cards[open];

  const close = useCallback(() => update(({ open: _open, ...rest }) => rest, true), [update]);
  useEffect(() => context.onEscape(() => (openCard ? (close(), true) : false)), [openCard, close]);
  // The open editor's unwritten work, such as text being typed, written before the tab closes.
  const editorFlush = useRef<() => void>(undefined);
  const onFlush = useCallback((run: () => void) => {
    editorFlush.current = run;
    return () => {
      if (editorFlush.current === run) editorFlush.current = undefined;
    };
  }, []);
  useEffect(
    () =>
      context.onBeforeClose(async () => {
        editorFlush.current?.();
        flush();
        await canvas.flush();
      }),
    [canvas.flush, flush],
  );

  const step = useCallback(
    (target: CanvasTarget, direction: "undo" | "redo") =>
      void canvas.step(target, direction).then((result: CanvasWriteResult) => {
        if (!result.ok || !result.kept.length) return;
        const names = result.kept.map((kept) =>
          "board" in target
            ? (canvas.snapshot?.board.cards[kept.id]?.title ?? "a card")
            : "a record",
        );
        setNotice(`Kept ${[...new Set(names)].join(", ")} as it is now.`);
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
      {openCard && open ? (
        <CardEditor
          cardId={open}
          card={openCard}
          row={canvas.snapshot.cards[open]}
          history={canvas.snapshot.history[open]}
          editable={!viewing}
          active={active}
          camera={data.cameras?.[open] ?? EDITOR_CAMERA}
          onCamera={(camera) =>
            update((data) => ({ ...data, cameras: { ...data.cameras, [open]: camera } }))
          }
          onBack={close}
          write={canvas.write}
          step={(direction) => step({ card: open }, direction)}
          newId={newId}
          onFlush={onFlush}
        />
      ) : (
        <Board
          name={tab.title}
          onRename={context.rename}
          snapshot={canvas.snapshot}
          camera={data.camera ?? defaultCamera}
          editable={!viewing}
          active={active}
          onCamera={(camera) => update((data) => ({ ...data, camera }))}
          onOpen={(id) => update((data) => ({ ...data, open: id }), true)}
          write={canvas.write}
          step={(direction) => step({ board: true }, direction)}
        />
      )}
    </div>
  );
}
