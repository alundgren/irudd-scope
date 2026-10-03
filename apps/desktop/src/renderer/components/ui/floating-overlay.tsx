import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { OverlayPosition } from "../../../workspace/contract.ts";

export function FloatingOverlay({
  as: Element = "div",
  className,
  label,
  ariaLabel,
  position,
  onPosition,
  children,
  style,
  disabled = false,
  onActivate,
  onKeyDown,
}: {
  as?: "div" | "aside";
  className: string;
  label: string;
  ariaLabel?: string;
  position?: OverlayPosition;
  onPosition: (position: OverlayPosition | undefined) => void;
  children: ReactNode;
  style?: CSSProperties;
  disabled?: boolean;
  onActivate?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const element = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState(position);
  const current = useRef(position);
  const commit = useRef(onPosition);
  commit.current = onPosition;
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    start: OverlayPosition;
    previous: OverlayPosition | undefined;
  } | null>(null);

  function measure() {
    const overlay = element.current;
    const container = overlay?.parentElement;
    if (!overlay || !container) return;
    const bounds = container.getBoundingClientRect();
    const rectangle = overlay.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !rectangle.width || !rectangle.height) return;
    return {
      x: rectangle.x - bounds.x,
      y: rectangle.y - bounds.y,
      maxX: Math.max(0, bounds.width - rectangle.width),
      maxY: Math.max(0, bounds.height - rectangle.height),
    };
  }
  function place(value: OverlayPosition | undefined) {
    current.current = value;
    setPlacement(value);
  }
  function fit(value: OverlayPosition) {
    const bounds = measure();
    if (!bounds) return value;
    return {
      x: Math.min(bounds.maxX, Math.max(0, value.x)),
      y: Math.min(bounds.maxY, Math.max(0, value.y)),
    };
  }
  useLayoutEffect(() => {
    if (!drag.current) place(position);
  }, [position?.x, position?.y]);
  useLayoutEffect(() => {
    const overlay = element.current;
    const container = overlay?.parentElement;
    if (!overlay || !container) return;
    const observer = new ResizeObserver(() => {
      const bounds = measure();
      if (!bounds || drag.current) return;
      const previous = current.current ?? bounds;
      const next = fit(previous);
      if (next.x === previous.x && next.y === previous.y) return;
      place(next);
      commit.current(next);
    });
    observer.observe(overlay);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  function start(event: PointerEvent<HTMLElement>) {
    onActivate?.();
    const target = event.target as HTMLElement;
    if (
      disabled ||
      event.defaultPrevented ||
      event.button !== 0 ||
      !event.isPrimary ||
      target.closest(
        '[data-floating-overlay-content], button, a, input, textarea, select, label, [contenteditable], [role="button"], [role="textbox"], [role="combobox"]',
      )
    )
      return;
    const bounds = measure();
    if (!bounds) return;
    event.preventDefault();
    event.currentTarget.focus();
    // Keep title clicks on their original element so double-click still maximizes the window.
    target.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: bounds,
      previous: current.current,
    };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const interaction = drag.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    place(
      fit({
        x: interaction.start.x + event.clientX - interaction.x,
        y: interaction.start.y + event.clientY - interaction.y,
      }),
    );
  }
  function finish(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    move(event);
    drag.current = null;
    commit.current(current.current);
  }
  function cancel() {
    const interaction = drag.current;
    if (!interaction) return;
    drag.current = null;
    place(interaction.previous ? fit(interaction.previous) : undefined);
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (
      disabled ||
      event.target !== event.currentTarget ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      place(undefined);
      commit.current(undefined);
      return;
    }
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    const bounds = measure();
    if (!direction || !bounds || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    const next = fit({ x: bounds.x + direction[0]! * step, y: bounds.y + direction[1]! * step });
    place(next);
    commit.current(next);
  }
  return (
    <Element
      ref={(node) => {
        element.current = node;
      }}
      aria-label={ariaLabel ?? `Move ${label}`}
      aria-description={
        disabled
          ? undefined
          : "Drag the frame to move. Arrow keys move; Shift moves farther. Home resets position."
      }
      tabIndex={disabled ? undefined : 0}
      className={`${className} ${disabled ? "" : "floating-overlay"}`}
      onFocus={onActivate}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        keyboard(event);
        if (!event.defaultPrevented) onKeyDown?.(event);
      }}
      style={{
        ...style,
        ...(placement && { left: placement.x, top: placement.y, right: "auto", bottom: "auto" }),
      }}
    >
      {children}
    </Element>
  );
}
