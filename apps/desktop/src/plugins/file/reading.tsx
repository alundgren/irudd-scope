import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { TabProps } from "../api.ts";

/** Receiver reading position only. Authored HTML and form values are never copied into tab state. */
export function GuestFileReading({
  tab,
  context,
  active,
  children,
}: Pick<TabProps, "tab" | "context" | "active"> & { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef({ tab, context, active });
  current.current = { tab, context, active };
  const position = useRef({ x: 0, y: 0 });
  const saved = tab.state.data.fileScroll;
  if (
    saved &&
    typeof saved === "object" &&
    "x" in saved &&
    "y" in saved &&
    typeof saved.x === "number" &&
    typeof saved.y === "number" &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y)
  )
    position.current = { x: Math.max(0, saved.x), y: Math.max(0, saved.y) };

  function record(x: number, y: number) {
    const { tab, context, active } = current.current;
    if (!active || !context.content?.available) return;
    if (x === position.current.x && y === position.current.y) return;
    position.current = { x, y };
    context.updateState({ ...tab.state, data: { ...tab.state.data, fileScroll: { x, y } } });
  }
  useLayoutEffect(() => {
    const element = container.current!;
    let frameWindow: Window | null = null;
    const captureFrame = () => {
      try {
        if (frameWindow) record(frameWindow.scrollX, frameWindow.scrollY);
      } catch {
        /* The HTML may have navigated to another origin. */
      }
    };
    const detach = () => {
      try {
        frameWindow?.removeEventListener("scroll", captureFrame);
      } catch {
        /* The previous document may now be cross-origin. */
      }
    };
    const loaded = () => {
      detach();
      // srcdoc shares Scope's origin. A document that navigates elsewhere has no readable position.
      try {
        frameWindow = element.querySelector("iframe")?.contentWindow ?? null;
        frameWindow?.addEventListener("scroll", captureFrame, { passive: true });
        frameWindow?.scrollTo(position.current.x, position.current.y);
      } catch {
        frameWindow = null;
      }
    };
    element.addEventListener("load", loaded, true);
    loaded();
    return () => {
      element.removeEventListener("load", loaded, true);
      detach();
    };
  }, []);
  useLayoutEffect(() => {
    if (!active) return;
    container.current?.scrollTo(position.current.x, position.current.y);
    try {
      container.current
        ?.querySelector("iframe")
        ?.contentWindow?.scrollTo(position.current.x, position.current.y);
    } catch {
      /* Cross-origin navigation has no local reading position. */
    }
  }, [active]);
  return (
    <div
      ref={container}
      className="guest-file-reading"
      onScroll={(event) => {
        if (event.target === event.currentTarget)
          record(event.currentTarget.scrollLeft, event.currentTarget.scrollTop);
      }}
    >
      {children}
    </div>
  );
}
