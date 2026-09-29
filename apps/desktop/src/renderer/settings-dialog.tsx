import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { GripHorizontal, MoveDiagonal2 } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type Bounds = { left: number; top: number; width: number; height: number };
type Viewport = { width: number; height: number };
type Adjustment = "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
const margin = 16;
const minimumWidth = 480;
const minimumHeight = 360;
const resizeEdges = ["n", "ne", "e", "s", "sw", "w", "nw"] as const;

function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function fitBounds(bounds: Bounds, viewport: Viewport): Bounds {
  const availableWidth = Math.max(1, viewport.width - margin * 2);
  const availableHeight = Math.max(1, viewport.height - margin * 2);
  const width = clamp(bounds.width, Math.min(minimumWidth, availableWidth), availableWidth);
  const height = clamp(bounds.height, Math.min(minimumHeight, availableHeight), availableHeight);
  return {
    left: clamp(bounds.left, margin, viewport.width - margin - width),
    top: clamp(bounds.top, margin, viewport.height - margin - height),
    width,
    height,
  };
}

function defaultBounds(viewport: Viewport): Bounds {
  const width = Math.min(1100, Math.max(640, viewport.width * 0.85));
  const height = Math.max(620, viewport.height * 0.85);
  return { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2, width, height };
}

function adjustBounds(
  bounds: Bounds,
  adjustment: Adjustment,
  x: number,
  y: number,
  viewport: Viewport,
): Bounds {
  if (adjustment === "move") {
    return fitBounds({ ...bounds, left: bounds.left + x, top: bounds.top + y }, viewport);
  }
  const minWidth = Math.min(minimumWidth, viewport.width - margin * 2);
  const minHeight = Math.min(minimumHeight, viewport.height - margin * 2);
  let { left, top } = bounds;
  let right = left + bounds.width;
  let bottom = top + bounds.height;
  if (adjustment.includes("w")) left = clamp(left + x, margin, right - minWidth);
  if (adjustment.includes("e")) right = clamp(right + x, left + minWidth, viewport.width - margin);
  if (adjustment.includes("n")) top = clamp(top + y, margin, bottom - minHeight);
  if (adjustment.includes("s"))
    bottom = clamp(bottom + y, top + minHeight, viewport.height - margin);
  return { left, top, width: right - left, height: bottom - top };
}

export function SettingsDialog({
  children,
  finalFocus,
}: Pick<ComponentProps<typeof DialogContent>, "children" | "finalFocus">) {
  const [viewport, setViewport] = useState(viewportSize);
  const [customBounds, setCustomBounds] = useState<Bounds | null>(null);
  const bounds = fitBounds(customBounds ?? defaultBounds(viewport), viewport);
  const interaction = useRef<{
    pointerId: number;
    adjustment: Adjustment;
    x: number;
    y: number;
    bounds: Bounds;
  } | null>(null);

  useEffect(() => {
    function resize() {
      interaction.current = null;
      setViewport(viewportSize());
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function start(event: PointerEvent<HTMLElement>, adjustment: Adjustment) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      pointerId: event.pointerId,
      adjustment,
      x: event.clientX,
      y: event.clientY,
      bounds,
    };
  }

  function move(event: PointerEvent) {
    const current = interaction.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setCustomBounds(
      adjustBounds(
        current.bounds,
        current.adjustment,
        event.clientX - current.x,
        event.clientY - current.y,
        viewport,
      ),
    );
  }

  function finish() {
    interaction.current = null;
  }

  function keyboard(event: KeyboardEvent, adjustment: Adjustment) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    setCustomBounds(
      adjustBounds(bounds, adjustment, direction[0]! * step, direction[1]! * step, viewport),
    );
  }

  return (
    <DialogContent
      className="settings-dialog"
      finalFocus={finalFocus}
      style={bounds}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      <DialogHeader onPointerDown={(event) => start(event, "move")}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="settings-dialog-move"
          aria-label="Move Settings"
          title="Drag to move. Arrow keys move when focused; Shift moves farther."
          onKeyDown={(event) => keyboard(event, "move")}
        >
          <GripHorizontal />
        </Button>
        <DialogTitle>Settings</DialogTitle>
      </DialogHeader>
      {children}
      <div className="settings-dialog-footer" />
      {resizeEdges.map((edge) => (
        <div
          key={edge}
          className="settings-dialog-resize"
          data-edge={edge}
          aria-hidden="true"
          onPointerDown={(event) => start(event, edge)}
        />
      ))}
      <Button
        variant="ghost"
        size="icon-sm"
        className="settings-dialog-resize"
        data-edge="se"
        aria-label="Resize Settings"
        title="Drag to resize. Arrow keys resize when focused; Shift resizes farther."
        onPointerDown={(event) => start(event, "se")}
        onKeyDown={(event) => keyboard(event, "se")}
      >
        <MoveDiagonal2 />
      </Button>
    </DialogContent>
  );
}
