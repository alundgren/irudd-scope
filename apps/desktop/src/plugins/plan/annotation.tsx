import { useEffect, useRef, type PointerEvent } from "react";
import { Check, Pin, Trash2, X } from "lucide-react";
import type { PlanAnnotation } from "@irudd-scope/protocol/plan";
import type { PlanDraft } from "./draft.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Textarea } from "../../renderer/components/ui/textarea.tsx";

import { PinPopover } from "./pin.tsx";

export async function markedScreenshot(draft: PlanDraft): Promise<string> {
  const image = new Image();
  image.src = `data:image/png;base64,${draft.image}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = draft.width;
  canvas.height = draft.height;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("Could not prepare the annotated screenshot.");
  drawing.drawImage(image, 0, 0);
  drawing.strokeStyle = "#b42335";
  drawing.lineWidth = 3;
  for (const [index, mark] of draft.annotations.entries()) {
    drawing.beginPath();
    if (mark.type === "pin") {
      const x = mark.at.x * draft.width,
        y = mark.at.y * draft.height;
      drawing.arc(x, y, 10, 0, Math.PI * 2);
      drawing.fillStyle = "#ffffff";
      drawing.fill();
      drawing.stroke();
      drawing.fillStyle = "#b42335";
      drawing.font = "12px system-ui";
      drawing.textAlign = "center";
      drawing.fillText(String(index + 1), x, y + 4);
      continue;
    }
    const x = mark.from.x * draft.width,
      y = mark.from.y * draft.height,
      tx = mark.to.x * draft.width,
      ty = mark.to.y * draft.height;
    if (mark.type === "box")
      drawing.rect(Math.min(x, tx), Math.min(y, ty), Math.abs(tx - x), Math.abs(ty - y));
    else {
      drawing.moveTo(x, y);
      drawing.lineTo(tx, ty);
      const angle = Math.atan2(ty - y, tx - x);
      drawing.moveTo(tx - 14 * Math.cos(angle - 0.5), ty - 14 * Math.sin(angle - 0.5));
      drawing.lineTo(tx, ty);
      drawing.lineTo(tx - 14 * Math.cos(angle + 0.5), ty - 14 * Math.sin(angle + 0.5));
    }
    drawing.stroke();
  }
  return canvas.toDataURL("image/png").split(",")[1];
}
export function AnnotationMarks({
  annotations,
  width,
  height,
}: {
  annotations: readonly PlanAnnotation[];
  width: number;
  height: number;
}) {
  return (
    <g stroke="#b42335" strokeWidth={3} fill="none">
      {annotations.map((mark, index) => {
        if (mark.type === "pin")
          return (
            <g key={index}>
              <circle cx={mark.at.x * width} cy={mark.at.y * height} r={10} fill="#ffffff" />
              <text
                x={mark.at.x * width}
                y={mark.at.y * height + 4}
                fontSize={12}
                textAnchor="middle"
                stroke="none"
                fill="#b42335"
              >
                {index + 1}
              </text>
            </g>
          );
        const x = mark.from.x * width,
          y = mark.from.y * height,
          tx = mark.to.x * width,
          ty = mark.to.y * height;
        if (mark.type === "box")
          return (
            <rect
              key={index}
              x={Math.min(x, tx)}
              y={Math.min(y, ty)}
              width={Math.abs(tx - x)}
              height={Math.abs(ty - y)}
            />
          );
        const angle = Math.atan2(ty - y, tx - x);
        return (
          <g key={index}>
            <line x1={x} y1={y} x2={tx} y2={ty} />
            <path
              d={`M ${tx - 14 * Math.cos(angle - 0.5)} ${ty - 14 * Math.sin(angle - 0.5)} L ${tx} ${ty} L ${tx - 14 * Math.cos(angle + 0.5)} ${ty - 14 * Math.sin(angle + 0.5)}`}
            />
          </g>
        );
      })}
    </g>
  );
}

export function CommentCapture({
  draft,
  onChange,
  onSave,
  onCancel,
  onDiscard,
  busy,
}: {
  draft: PlanDraft;
  onChange: (draft: PlanDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const capture = useRef<HTMLDivElement>(null);
  const comment = useRef<HTMLTextAreaElement>(null);
  const mark = draft.annotations.find((annotation) => annotation.type === "pin");
  const at = mark?.at ?? { x: 0.25, y: 0.25 };
  const placed = draft.annotations.length > 0;
  useEffect(() => {
    if (placed) comment.current?.focus();
    else capture.current?.focus();
  }, [placed, at.x, at.y]);
  function placePin(event: PointerEvent<SVGSVGElement>) {
    if (busy) return;
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return;
    event.preventDefault();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    onChange({
      ...draft,
      annotations: [
        {
          type: "pin",
          at: {
            x: Math.max(0, Math.min(1, point.x / draft.width)),
            y: Math.max(0, Math.min(1, point.y / draft.height)),
          },
        },
      ],
    });
  }
  return (
    <div
      ref={capture}
      className="plan-capture"
      role="dialog"
      aria-label="Comment on captured page"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onCancel();
        }
      }}
    >
      <div className="plan-capture-image">
        <svg
          ref={svg}
          role="img"
          aria-label="Frozen plan screenshot, draw annotations here"
          viewBox={`0 0 ${draft.width} ${draft.height}`}
          preserveAspectRatio="none"
          onPointerDown={placePin}
        >
          <image
            href={`data:image/png;base64,${draft.image}`}
            width={draft.width}
            height={draft.height}
          />
          <AnnotationMarks
            annotations={draft.annotations}
            width={draft.width}
            height={draft.height}
          />
        </svg>
      </div>
      {placed && (
        <PinPopover x={at.x} y={at.y}>
          <div className="plan-pin-heading">
            <Pin aria-hidden="true" />
            <div className="plan-actions">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Discard comment"
                title="Discard comment"
                disabled={busy}
                onClick={onDiscard}
              >
                <Trash2 />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Back to plan"
                title="Back to plan, keep draft"
                disabled={busy}
                onClick={onCancel}
              >
                <X />
              </Button>
            </div>
          </div>
          <Textarea
            ref={comment}
            aria-label="Comment"
            placeholder="Add a comment…"
            disabled={busy}
            maxLength={16_384}
            rows={2}
            value={draft.text}
            onChange={(event) => onChange({ ...draft, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!busy && draft.text.trim()) onSave();
              }
            }}
          />
          <div className="plan-pin-actions">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !draft.text.trim()}
              onClick={onSave}
            >
              <Check />
              {busy ? "Saving…" : "Add comment"}
            </Button>
          </div>
        </PinPopover>
      )}
    </div>
  );
}
