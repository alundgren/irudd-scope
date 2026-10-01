import { useEffect, useState, type RefObject } from "react";
import type { PlanSnapshot, PlanViewport } from "@irudd-scope/protocol/plan";
import type { PlanDraft } from "./draft.ts";
import { AnnotationMarks } from "./annotation.tsx";

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
}: {
  iframe: RefObject<HTMLIFrameElement | null>;
  snapshot?: PlanSnapshot;
  revision: number;
  draft: PlanDraft | null;
}) {
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
  );
}
