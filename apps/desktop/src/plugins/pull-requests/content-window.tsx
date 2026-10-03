import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ArrowDownRight, Maximize2, Minimize2, X } from "lucide-react";
import type { OverlayPosition } from "../../workspace/contract.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { FloatingOverlay } from "../../renderer/components/ui/floating-overlay.tsx";
import { pullRequestsDocument } from "./frame-sdk.ts";
import type { ContentWindow } from "./window-content.ts";
import type { PullRequestsFrameHost } from "./frame-host.ts";
import "./content-window.css";

export function ContentWindowView({
  content,
  host,
  onError,
}: {
  content: ContentWindow;
  host: PullRequestsFrameHost;
  onError: (error: string) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [position, setPosition] = useState<OverlayPosition>();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [closing, setClosing] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const document = useMemo(
    () => pullRequestsDocument(content.html, content.identity, content.environment),
    [content.html, content.identity, content.environment],
  );
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  async function close() {
    if (closing) return;
    setClosing(true);
    try {
      await host.close(content.environment.id);
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : "Could not close this window.");
    } finally {
      setClosing(false);
    }
  }
  return (
    <FloatingOverlay
      className={`scope-content-window ${maximized ? "scope-content-maximized" : ""}`}
      label="content window"
      position={maximized ? { x: 0, y: 0 } : position}
      onPosition={setPosition}
      disabled={maximized}
      onActivate={() => host.focus(content.environment.id)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void close();
        }
      }}
      style={{ ...(maximized ? { width: "100%", height: "100%" } : size), zIndex: content.z }}
    >
      <section role="dialog" aria-label={content.title}>
        <header
          className="scope-content-toolbar"
          onDoubleClick={(event) => {
            if (!(event.target as Element).closest("button")) setMaximized((value) => !value);
          }}
        >
          <h2 title={content.title}>{content.title}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={maximized ? "Restore content window" : "Maximize content window"}
            onClick={() => setMaximized((value) => !value)}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button
            ref={closeButton}
            variant="ghost"
            size="icon-sm"
            disabled={closing}
            aria-label="Close content window"
            onClick={() => void close()}
          >
            <X />
          </Button>
        </header>
        <iframe
          ref={(element) => host.attach(content.environment.id, element)}
          name={`scope-pull-requests-${content.identity.tabId}-${content.identity.channel}`}
          title={content.title}
          className="html-preview scope-content-document"
          data-floating-overlay-content
          srcDoc={document}
        />
        {!maximized && <ResizeGrip onSize={setSize} />}
      </section>
    </FloatingOverlay>
  );
}

function ResizeGrip({ onSize }: { onSize: (size: { width: number; height: number }) => void }) {
  const resize = useRef<{
    pointer: number;
    x: number;
    y: number;
    width: number;
    height: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);
  function startResize(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const panel = event.currentTarget.closest(".scope-content-window")!;
    const rectangle = panel.getBoundingClientRect();
    const bounds = panel.parentElement!.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: rectangle.width,
      height: rectangle.height,
      maxWidth: bounds.right - rectangle.left,
      maxHeight: bounds.bottom - rectangle.top,
    };
  }
  function resizeTo(event: PointerEvent<HTMLButtonElement>) {
    const current = resize.current;
    if (!current || current.pointer !== event.pointerId) return;
    onSize({
      width: Math.min(current.maxWidth, Math.max(360, current.width + event.clientX - current.x)),
      height: Math.min(
        current.maxHeight,
        Math.max(240, current.height + event.clientY - current.y),
      ),
    });
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="scope-content-resize"
      aria-label="Resize content window"
      title="Drag to resize. Arrow keys resize; Shift resizes farther."
      onPointerDown={startResize}
      onPointerMove={resizeTo}
      onPointerUp={() => {
        resize.current = null;
      }}
      onPointerCancel={() => {
        resize.current = null;
      }}
      onLostPointerCapture={() => {
        resize.current = null;
      }}
      onKeyDown={(event) => {
        const directions = {
          ArrowRight: [1, 0],
          ArrowLeft: [-1, 0],
          ArrowDown: [0, 1],
          ArrowUp: [0, -1],
        }[event.key];
        if (!directions) return;
        event.preventDefault();
        event.stopPropagation();
        const panel = event.currentTarget.closest(".scope-content-window")!.getBoundingClientRect();
        const step = event.shiftKey ? 40 : 10;
        onSize({
          width: Math.max(360, panel.width + directions[0]! * step),
          height: Math.max(240, panel.height + directions[1]! * step),
        });
      }}
    >
      <ArrowDownRight />
    </Button>
  );
}
