import { useEffect, useRef } from "react";
import { framePoint, observeFrameDocuments } from "./frame-documents.ts";

export function PresentationPointer({ tabId }: { tabId: string }) {
  const pointer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = pointer.current;
    const pane = document.getElementById(`pane-${tabId}`);
    if (!overlay || !pane) return;
    const marks = Array.from(overlay.children) as HTMLElement[];

    const draw = (event: PointerEvent, frames: readonly HTMLIFrameElement[] = []) => {
      if (event.pointerType === "touch") {
        overlay.style.opacity = "0";
        return;
      }
      const { x, y } = framePoint(frames, event.clientX, event.clientY);
      for (const mark of marks) {
        mark.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      }
      overlay.style.opacity = "1";
    };
    const move = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        pane.contains(event.target) &&
        event.target.closest(".diagram-view")
      )
        draw(event);
      else overlay.style.opacity = "0";
    };
    const hide = () => {
      overlay.style.opacity = "0";
    };
    const leave = (event: PointerEvent) => {
      if (!event.relatedTarget) hide();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerout", leave);
    window.addEventListener("blur", hide);
    const stopFrames = observeFrameDocuments(pane, (document, frames) => {
      const style = document.createElement("style");
      style.textContent = "* { cursor: none !important; }";
      (document.head ?? document.documentElement).append(style);
      const move = (event: PointerEvent) => draw(event, frames);
      document.addEventListener("pointermove", move, { capture: true, passive: true });
      document.addEventListener("pointerout", leave, true);
      return () => {
        hide();
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerout", leave, true);
        style.remove();
      };
    });
    return () => {
      stopFrames();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", hide);
    };
  }, [tabId]);

  return (
    <div className="presentation-pointer" ref={pointer} aria-hidden="true">
      <span className="presentation-pointer-trail" />
      <span className="presentation-pointer-trail" />
      <span className="presentation-pointer-trail" />
      <span className="presentation-pointer-tip" />
    </div>
  );
}
