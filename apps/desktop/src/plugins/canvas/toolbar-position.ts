import { useSyncExternalStore } from "react";
import type { OverlayPosition } from "../../workspace/contract.ts";

// One position for every card in every canvas, read from main once per window.
let position: OverlayPosition | null | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  loading ??= window.scope.canvasToolbarPosition().then(
    (saved) => {
      position ??= saved;
      notify();
    },
    () => {
      position ??= null;
      notify();
    },
  );
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function save(next: OverlayPosition | undefined) {
  position = next ?? null;
  notify();
  void window.scope.saveCanvasToolbarPosition(next ?? null).catch(() => {});
}

/** Where the card editor's floating toolbar sits; `loaded` is false until main has answered. */
export function useToolbarPosition() {
  const current = useSyncExternalStore(subscribe, () => position);
  return { loaded: current !== undefined, position: current ?? undefined, save };
}
