import { useCallback, useContext, useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { SettingsContext } from "../../renderer/settings-context.tsx";
import { HistoryButtons } from "./board-toolbar.tsx";
import { ChatSlot } from "./chat/slot.tsx";
import { findCardType } from "./cards/registry.ts";
import { findCardView } from "./cards/views.ts";
import type {
  BoardCard,
  CanvasCamera,
  CanvasCardRow,
  CanvasHistoryState,
  CanvasOp,
} from "./contract.ts";
import type { CanvasWrite } from "./use-canvas.ts";

/** Hands out IDs main reserved for the canvas, and asks for more before they run out. */
export function useIdPool(tabId: string) {
  const pool = useRef<string[]>([]);
  const loading = useRef(false);
  const fallback = useRef(0);
  const refill = useCallback(() => {
    if (loading.current || pool.current.length >= 16) return;
    loading.current = true;
    void window.scope
      .canvasIds({ tabId, count: 32 })
      .then((ids) => pool.current.push(...ids))
      .catch(() => {})
      .finally(() => {
        loading.current = false;
      });
  }, [tabId]);
  useEffect(refill, [refill]);
  return useCallback(() => {
    const id = pool.current.shift();
    refill();
    // Without a reserved ID the record waits for main to name it, so it shows a moment later.
    return id ?? `$new${++fallback.current}`;
  }, [refill]);
}

/** A card's editor filling the tab, with its title, a way back to the board, and its own undo. */
export function CardEditor({
  tabId,
  cardId,
  card,
  row,
  history,
  editable,
  active,
  camera,
  onCamera,
  onBack,
  write,
  step,
  newId,
  onFlush,
}: {
  tabId: string;
  cardId: string;
  card: BoardCard;
  row: CanvasCardRow;
  history: CanvasHistoryState | undefined;
  editable: boolean;
  active: boolean;
  camera: CanvasCamera;
  onCamera: (camera: CanvasCamera) => void;
  onBack: () => void;
  write: CanvasWrite;
  step: (direction: "undo" | "redo") => void;
  newId: () => string;
  onFlush: (flush: () => void) => () => void;
}) {
  // An older Scope keeps a newer card's content byte for byte and never edits it.
  const chat = useContext(SettingsContext)?.settings?.cardChatEnabled && editable && active;
  const known = row.typeVersion <= (findCardType(row.type)?.version ?? 0);
  const view = known ? findCardView(row.type) : undefined;
  const target = { card: cardId };
  const save = useCallback(
    (label: string, ops: CanvasOp[]) => void write({ card: cardId }, label, ops),
    [write, cardId],
  );
  return (
    <div className="canvas-card-editor">
      <div className="canvas-card-header" role="toolbar" aria-label="Card">
        <Button size="sm" variant="ghost" title="Back to board · Escape" onClick={onBack}>
          <ArrowLeft /> Board
        </Button>
        <h2 className="canvas-card-heading">{card.title}</h2>
        {editable && <HistoryButtons history={history} onStep={step} />}
      </div>
      <div className="canvas-card-main">
        {view ? (
          <view.Editor
            key={cardId}
            cardId={target.card}
            content={row.content}
            editable={editable}
            active={active}
            camera={camera}
            onCamera={onCamera}
            write={save}
            step={step}
            newId={newId}
            onFlush={onFlush}
          />
        ) : (
          <p className="content-notice" role="status">
            This card needs a newer Scope. Its content is kept as it is.
          </p>
        )}
        {chat && <ChatSlot tabId={tabId} cardId={cardId} />}
      </div>
    </div>
  );
}
