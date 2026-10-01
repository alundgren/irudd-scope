import { useRef, useState, type PointerEvent } from "react";
import type { PlanAnnotation } from "@irudd-scope/protocol/plan";
import type { PlanDraft } from "./draft.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { Textarea } from "../../renderer/components/ui/textarea.tsx";

type Point = { x: number; y: number };
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
  const [tool, setTool] = useState<PlanAnnotation["type"]>("arrow");
  const [start, setStart] = useState<Point>();
  const [preview, setPreview] = useState<PlanAnnotation>();
  function point(event: PointerEvent<SVGSVGElement>): Point {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const value = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(1, value.x / draft.width)),
      y: Math.max(0, Math.min(1, value.y / draft.height)),
    };
  }
  function finish(event: PointerEvent<SVGSVGElement>) {
    if (!start) return;
    const at = point(event);
    const mark: PlanAnnotation =
      tool === "pin" ? { type: "pin", at } : { type: tool, from: start, to: at };
    onChange({ ...draft, annotations: [...draft.annotations, mark] });
    setStart(undefined);
    setPreview(undefined);
  }
  return (
    <div
      className="plan-capture"
      role="dialog"
      aria-label="Comment on captured page"
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
          onPointerDown={(event) => {
            if (busy || draft.annotations.length >= 50) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setStart(point(event));
          }}
          onPointerMove={(event) => {
            if (start)
              setPreview(
                tool === "pin"
                  ? { type: "pin", at: point(event) }
                  : { type: tool, from: start, to: point(event) },
              );
          }}
          onPointerUp={finish}
          onPointerCancel={() => {
            setStart(undefined);
            setPreview(undefined);
          }}
        >
          <image
            href={`data:image/png;base64,${draft.image}`}
            width={draft.width}
            height={draft.height}
          />
          <AnnotationMarks
            annotations={preview ? [...draft.annotations, preview] : draft.annotations}
            width={draft.width}
            height={draft.height}
          />
        </svg>
      </div>
      <section className="plan-capture-controls">
        <div className="plan-actions" role="group" aria-label="Annotation tools">
          {(["arrow", "box", "pin"] as const).map((value) => (
            <Button
              key={value}
              disabled={busy}
              variant={tool === value ? "secondary" : "ghost"}
              aria-pressed={tool === value}
              onClick={() => setTool(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </Button>
          ))}
          <Button
            variant="ghost"
            disabled={!draft.annotations.length || busy}
            onClick={() => onChange({ ...draft, annotations: draft.annotations.slice(0, -1) })}
          >
            Undo mark
          </Button>
          <Button
            variant="ghost"
            disabled={!draft.annotations.length || busy}
            onClick={() => onChange({ ...draft, annotations: [] })}
          >
            Clear marks
          </Button>
        </div>
        <label>
          Comment
          <Textarea
            aria-label="Comment"
            autoFocus
            disabled={busy}
            maxLength={16_384}
            rows={3}
            value={draft.text}
            onChange={(event) => onChange({ ...draft, text: event.target.value })}
          />
        </label>
        <label>
          Page label, optional
          <Input
            disabled={busy}
            maxLength={512}
            value={draft.page}
            onChange={(event) => onChange({ ...draft, page: event.target.value })}
          />
        </label>
        <div className="plan-actions">
          <Button disabled={busy || !draft.text.trim()} onClick={onSave}>
            {busy ? "Adding…" : "Add comment"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Back to plan
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onDiscard}>
            Discard comment
          </Button>
          <span className="secondary">Captured version {draft.revision}</span>
        </div>
      </section>
    </div>
  );
}
