import { useEffect, useState, type RefObject } from "react";
import type { PlanCommand, PlanSnapshot, PlanViewport } from "@irudd-scope/protocol/plan";
import type { PlanDraft } from "./draft.ts";
import { AnnotationMarks } from "./annotation.tsx";
import { PinPopover } from "./pin.tsx";
import { CommentThread } from "./comment-thread.tsx";
import { Button } from "../../renderer/components/ui/button.tsx";

export function readDocumentViewport(iframe: HTMLIFrameElement): PlanViewport | undefined {
  try {
    const documentWindow = iframe.contentWindow;
    if (!documentWindow) return;
    return {
      scrollX: documentWindow.scrollX,
      scrollY: documentWindow.scrollY,
      width: documentWindow.innerWidth,
      height: documentWindow.innerHeight,
    };
  } catch {
    /* A plan can navigate outside its initial origin. */
    return;
  }
}

export function PendingMarks({
  iframe,
  snapshot,
  revision,
  draft,
  command,
  busy,
  onResume,
}: {
  iframe: RefObject<HTMLIFrameElement | null>;
  snapshot?: PlanSnapshot;
  revision: number;
  draft: PlanDraft | null;
  command: (command: PlanCommand) => Promise<boolean>;
  busy: boolean;
  onResume: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [viewport, setViewport] = useState<PlanViewport>();
  useEffect(() => {
    const frame = iframe.current;
    if (!frame) return;
    let remove = () => {};
    const update = () => setViewport(readDocumentViewport(frame));
    const observe = () => {
      remove();
      update();
      try {
        const documentWindow = frame.contentWindow;
        if (!documentWindow) return;
        documentWindow.addEventListener("scroll", update);
        documentWindow.addEventListener("resize", update);
        remove = () => {
          try {
            documentWindow.removeEventListener("scroll", update);
            documentWindow.removeEventListener("resize", update);
          } catch {
            /* Navigation may have changed the document's origin. */
          }
        };
      } catch {
        /* Cross-origin pages retain their marks in captured screenshots. */
      }
    };
    frame.addEventListener("load", observe);
    observe();
    return () => {
      frame.removeEventListener("load", observe);
      remove();
    };
  }, [iframe, revision]);
  if (!viewport) return null;
  const marks = [
    ...(snapshot?.comments ?? []).filter((comment) => !comment.resolved),
    ...(draft ? [draft] : []),
  ].filter(
    (comment) =>
      comment.revision === revision &&
      comment.viewport &&
      comment.viewport.width === viewport.width &&
      comment.annotations.length > 0,
  );
  return (
    <div
      className="plan-pin-layer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selected) {
          event.stopPropagation();
          setSelected(undefined);
        }
      }}
    >
      <svg
        className="plan-pending-marks"
        role="img"
        aria-label="Pending comment marks"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      >
        {marks.map((comment) => (
          <svg
            key={"id" in comment ? comment.id : comment.requestId}
            x={comment.viewport!.scrollX - viewport.scrollX}
            y={comment.viewport!.scrollY - viewport.scrollY}
            width={comment.viewport!.width}
            height={comment.viewport!.height}
            viewBox={`0 0 ${comment.viewport!.width} ${comment.viewport!.height}`}
            overflow="visible"
          >
            <AnnotationMarks
              annotations={comment.annotations}
              width={comment.viewport!.width}
              height={comment.viewport!.height}
            />
          </svg>
        ))}
      </svg>
      {marks.map((comment) => {
        const mark = comment.annotations[0];
        const point = mark.type === "pin" ? mark.at : mark.from;
        const x =
          (point.x * comment.viewport!.width + comment.viewport!.scrollX - viewport.scrollX) /
          viewport.width;
        const y =
          (point.y * comment.viewport!.height + comment.viewport!.scrollY - viewport.scrollY) /
          viewport.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        const id = "id" in comment ? comment.id : comment.requestId;
        const number =
          "id" in comment
            ? (snapshot?.comments.findIndex((entry) => entry.id === id) ?? 0) + 1
            : "+";
        return (
          <div key={id}>
            <Button
              className="plan-comment-pin"
              size="icon-sm"
              variant="outline"
              aria-label={"id" in comment ? `Comment: ${comment.text}` : "Open draft comment"}
              aria-expanded={selected === id}
              title={comment.text || "Resume comment"}
              style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
              onClick={() =>
                "id" in comment ? setSelected(selected === id ? undefined : id) : onResume()
              }
            >
              {number}
            </Button>
            {selected === id && "id" in comment && snapshot && (
              <PinPopover x={x} y={y}>
                <CommentThread
                  comment={comment}
                  snapshot={snapshot}
                  command={command}
                  busy={busy}
                  onClose={() => setSelected(undefined)}
                />
              </PinPopover>
            )}
          </div>
        );
      })}
    </div>
  );
}
