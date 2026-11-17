import { useLayoutEffect, useRef } from "react";
import type { ChatBounds } from "./contract.ts";

// Dialogs in the workspace page sit below the chat view, so the panel steps aside while one is open.
const COVERING = '[role="dialog"], [role="alertdialog"]';

/** Keeps room beside the card editor and tells main where to show the chat view. */
export function ChatSlot({ tabId, cardId }: { tabId: string; cardId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = slot.current!;
    const target = { tabId, cardId };
    let sent = "";
    let frame = 0;
    const report = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const bounds: ChatBounds | null =
        rect.width < 1 || rect.height < 1 || document.querySelector(COVERING)
          ? null
          : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      const key = JSON.stringify([bounds, theme]);
      if (key === sent) return;
      sent = key;
      void window.scope.chatLayout({ target, bounds, theme }).catch(() => {});
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(report);
    };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(element);
    sizes.observe(document.documentElement);
    const portals = new MutationObserver(schedule);
    portals.observe(document.body, { childList: true });
    portals.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      portals.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      void window.scope.chatLayout({ target, bounds: null, theme: "light" }).catch(() => {});
    };
  }, [tabId, cardId]);
  return <div ref={slot} className="canvas-chat-slot" aria-hidden />;
}
