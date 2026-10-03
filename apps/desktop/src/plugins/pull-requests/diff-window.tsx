import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowDownRight, FileDiff, Maximize2, Minimize2, X } from "lucide-react";
import type {
  PullRequest,
  PullRequestDetail,
  PullRequestsCommand,
} from "@irudd-scope/protocol/pull-requests";
import type { OverlayPosition } from "../../workspace/contract.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { FloatingOverlay } from "../../renderer/components/ui/floating-overlay.tsx";
import { DiffContent } from "./diff-content.tsx";
import "./diff-window.css";

export type DiffRequest = {
  pr: PullRequest;
  command: Extract<PullRequestsCommand, { action: "detail" }>;
};

export function DiffWindow({
  request,
  latest,
  onLatest,
  onClose,
}: {
  request: DiffRequest;
  latest?: PullRequest;
  onLatest: (pr: PullRequest) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PullRequestDetail>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [split, setSplit] = useState(false);
  const [filesVisible, setFilesVisible] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [position, setPosition] = useState<OverlayPosition>();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const close = useRef<HTMLButtonElement>(null);
  const captured = request.command.captured!;
  const changed =
    latest && (latest.headOid !== captured.headOid || latest.baseOid !== captured.baseOid);
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    let mounted = true;
    setDetail(undefined);
    setError("");
    void window.scope
      .pullRequestsCommand({ ...request.command, requestId: crypto.randomUUID() })
      .then((reply) => {
        if (
          reply.type !== "detail" ||
          reply.nodeId !== request.pr.nodeId ||
          reply.tabId !== request.command.tabId ||
          reply.detail.headOid !== captured.headOid
        )
          throw new Error("These details do not match the displayed comparison.");
        if (mounted) setDetail(reply.detail);
      })
      .catch((failure: unknown) => {
        if (mounted)
          setError(failure instanceof Error ? failure.message : "Could not load this diff.");
      });
    return () => {
      mounted = false;
    };
  }, [request, retry]);
  return (
    <FloatingOverlay
      className={`pr-diff-window ${maximized ? "pr-diff-maximized" : ""}`}
      label="diff window"
      position={maximized ? { x: 0, y: 0 } : position}
      onPosition={setPosition}
      style={maximized ? { width: "100%", height: "100%" } : size}
    >
      {(handle) => (
        <section
          role="dialog"
          aria-label={`Changes in #${request.pr.number}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        >
          <header
            className="pr-diff-toolbar"
            onDoubleClick={(event) => {
              if (!(event.target as Element).closest("button")) setMaximized((value) => !value);
            }}
          >
            {!maximized && handle}
            <FileDiff size={18} aria-hidden="true" />
            <h2 title={request.pr.title}>
              #{request.pr.number} {request.pr.title}
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={maximized ? "Restore diff window" : "Maximize diff window"}
              onClick={() => setMaximized((value) => !value)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </Button>
            <Button
              ref={close}
              variant="ghost"
              size="icon-sm"
              aria-label="Close diff window"
              onClick={onClose}
            >
              <X />
            </Button>
          </header>
          <div className="pr-diff-options">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={filesVisible}
              onClick={() => setFilesVisible((value) => !value)}
            >
              Files{detail ? ` ${detail.files.length}` : ""}
            </Button>
            <div role="group" aria-label="Diff layout">
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={!split}
                onClick={() => setSplit(false)}
              >
                Unified
              </Button>
              <Button variant="ghost" size="sm" aria-pressed={split} onClick={() => setSplit(true)}>
                Split
              </Button>
            </div>
            <span className="pr-diff-commits" title={`${captured.baseOid} → ${captured.headOid}`}>
              {captured.baseOid.slice(0, 7)} → {captured.headOid.slice(0, 7)}
            </span>
          </div>
          {changed && (
            <div className="pr-diff-notice" role="status">
              This comparison has changed.{" "}
              <Button variant="outline" size="sm" onClick={() => onLatest(latest)}>
                Load latest comparison
              </Button>
            </div>
          )}
          {!latest && (
            <div className="pr-diff-notice" role="status">
              This PR is no longer in the open inbox. The displayed comparison is kept here.
            </div>
          )}
          {error ? (
            <div className="pr-diff-message" role="alert">
              {error}{" "}
              <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                Retry loading diff
              </Button>
            </div>
          ) : !detail ? (
            <div className="pr-diff-message" role="status">
              Loading changed files…
            </div>
          ) : (
            <DiffContent detail={detail} split={split} filesVisible={filesVisible} />
          )}
          {!maximized && <ResizeGrip onSize={setSize} />}
        </section>
      )}
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
    const panel = event.currentTarget.closest(".pr-diff-window")!;
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
      className="pr-diff-resize"
      aria-label="Resize diff window"
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
        const panel = event.currentTarget.closest(".pr-diff-window")!.getBoundingClientRect();
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
