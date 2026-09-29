import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

export type TabDropEdge = "before" | "after";
export type ReorderTab = (id: string, targetId: string, edge: TabDropEdge) => void;

export function useTabDrag(onReorder: ReorderTab, onClose: (id: string) => Promise<void>) {
  const source = useRef<string | null>(null);
  const blockedOrigin = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string; edge: TabDropEdge } | "trash" | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelOpen() {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  }
  function finish() {
    cancelOpen();
    source.current = null;
    setDraggingId(null);
    setTarget(null);
  }
  useEffect(() => {
    window.addEventListener("dragend", finish);
    window.addEventListener("drop", finish);
    return () => {
      cancelOpen();
      window.removeEventListener("dragend", finish);
      window.removeEventListener("drop", finish);
    };
  }, []);

  function accept(event: DragEvent) {
    if (!source.current) return false;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    return true;
  }
  function edgeAt(event: DragEvent, axis: "horizontal" | "vertical"): TabDropEdge {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      axis === "horizontal"
        ? event.clientX < rect.x + rect.width / 2
        : event.clientY < rect.y + rect.height / 2
    )
      ? "before"
      : "after";
  }
  function leave(event: DragEvent) {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      setTarget(null);
  }
  function row(id: string, axis: "horizontal" | "vertical") {
    return {
      draggable: true,
      "data-dragging": draggingId === id || undefined,
      "data-drop-edge": target && target !== "trash" && target.id === id ? target.edge : undefined,
      onPointerDownCapture(event: PointerEvent) {
        blockedOrigin.current = Boolean(
          (event.target as Element).closest("[data-tab-drag-ignore]"),
        );
      },
      onDragStart(event: DragEvent) {
        if (blockedOrigin.current) {
          event.preventDefault();
          return;
        }
        source.current = id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-scope-tab", id);
        setDraggingId(id);
      },
      onDragOver(event: DragEvent) {
        if (!accept(event)) return;
        setTarget(source.current === id ? null : { id, edge: edgeAt(event, axis) });
        if (axis === "vertical") {
          const list = event.currentTarget.parentElement;
          if (!list) return;
          const bounds = list.getBoundingClientRect();
          if (event.clientY < bounds.top + 24) list.scrollBy(0, -16);
          else if (event.clientY > bounds.bottom - 24) list.scrollBy(0, 16);
        }
      },
      onDragLeave: leave,
      onDrop(event: DragEvent) {
        if (!accept(event)) return;
        onReorder(source.current!, id, edgeAt(event, axis));
        finish();
      },
      onDragEnd: finish,
    };
  }
  function keyboard(
    event: KeyboardEvent,
    id: string,
    ids: readonly string[],
    axis: "horizontal" | "vertical",
  ) {
    if (event.key === "Delete" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void onClose(id);
      return;
    }
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const previous = axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const next = axis === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (event.key !== previous && event.key !== next) return;
    event.preventDefault();
    const offset = event.key === previous ? -1 : 1;
    const neighbor = ids[ids.indexOf(id) + offset];
    if (neighbor) onReorder(id, neighbor, offset < 0 ? "before" : "after");
  }
  return {
    row,
    keyboard,
    draggingId,
    drawerTrigger(open: () => void) {
      function hover(event: DragEvent) {
        if (!accept(event)) return;
        setTarget(null);
        if (openTimer.current === null) openTimer.current = setTimeout(open, 350);
      }
      return {
        onDragEnter: hover,
        onDragOver: hover,
        onDragLeave(event: DragEvent) {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            cancelOpen();
        },
      };
    },
    trash: {
      "data-drop-target": target === "trash" || undefined,
      onDragOver(event: DragEvent) {
        if (accept(event)) setTarget("trash");
      },
      onDragLeave: leave,
      onDrop(event: DragEvent) {
        if (!accept(event)) return;
        const id = source.current!;
        finish();
        void onClose(id);
      },
    },
  };
}

export type TabDrag = ReturnType<typeof useTabDrag>;
