import { memo, useLayoutEffect, useRef, type PointerEvent } from "react";
import { MAX_TEXT, nameOf, type Area, type BoxRecord, type SectionRecord } from "./contract.ts";
import { titleOffset, titleWidth } from "./geometry.ts";
import { Outline } from "./outline.tsx";

/** One edge strip of a box: a side and which half of it, or one edge of a diamond. */
export type Strip =
  | { side: "n" | "e" | "s" | "w"; half: 0 | 1 }
  | { side: "diamond"; from: [number, number]; to: [number, number] };

export type NodeEvents = {
  move: (event: PointerEvent, id: string) => void;
  select: (event: PointerEvent, id: string) => void;
  resize: (event: PointerEvent, id: string, handle: string) => void;
  connect: (event: PointerEvent, id: string, strip: Strip) => void;
  title: (event: PointerEvent, id: string) => void;
  text: (id: string, text: string) => void;
  finishText: () => void;
};

const SIDES: Strip[] = (["n", "e", "s", "w"] as const).flatMap((side) => [
  { side, half: 0 as const },
  { side, half: 1 as const },
]);
const DIAMOND_EDGES: Strip[] = [
  [
    [0.5, 0],
    [1, 0.5],
  ],
  [
    [1, 0.5],
    [0.5, 1],
  ],
  [
    [0.5, 1],
    [0, 0.5],
  ],
  [
    [0, 0.5],
    [0.5, 0],
  ],
].map(([from, to]) => ({ side: "diamond", from, to }) as Strip);
const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const SECTION_HANDLES = ["nw", "ne", "se", "sw"];

function stripStyle(box: BoxRecord, strip: Strip) {
  if (strip.side === "diamond") {
    const [[x1, y1], [x2, y2]] = [strip.from, strip.to];
    const dx = (x2 - x1) * box.w;
    const dy = (y2 - y1) * box.h;
    return {
      left: ((x1 + x2) * box.w) / 2,
      top: ((y1 + y2) * box.h) / 2,
      width: Math.max(0, Math.hypot(dx, dy) - 36),
      height: 22,
      transform: `translate(-50%, -50%) rotate(${Math.atan2(dy, dx)}rad)`,
    };
  }
  // Strips stop just short of the 14px resize handles, so even a 60px-tall box keeps side strips.
  const across = strip.side === "n" || strip.side === "s";
  const along = strip.half ? "calc(50% + 9px)" : "9px";
  const edge = strip.side === "n" || strip.side === "w" ? "-11px" : "calc(100% - 11px)";
  return {
    left: across ? along : edge,
    top: across ? edge : along,
    width: across ? "calc(50% - 18px)" : 22,
    height: across ? 22 : "calc(50% - 18px)",
  };
}

function TextField({ id, area, on }: { id: string; area: Area; on: NodeEvents }) {
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const section = area.type === "section";
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    if (section) element.style.width = `${titleWidth(area)}px`;
    else {
      element.style.height = "0px";
      element.style.height = `${Math.min(area.h, element.scrollHeight)}px`;
    }
  });
  useLayoutEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const props = {
    ref: field,
    className: "boxes-text",
    "aria-label": section ? "Section title" : "Box text",
    value: area.text ?? "",
    maxLength: MAX_TEXT,
    placeholder: section ? "Section" : "Type here…",
    style: section ? { left: titleOffset(area, titleWidth(area)) } : undefined,
    onPointerDown: (event: PointerEvent) => event.stopPropagation(),
    onChange: (event: { currentTarget: { value: string } }) =>
      on.text(id, event.currentTarget.value),
    onKeyDown: (event: React.KeyboardEvent) => {
      const done =
        event.key === "Escape" ||
        (event.key === "Enter" && (section || event.metaKey || event.ctrlKey));
      if (!done) return;
      event.preventDefault();
      event.stopPropagation();
      on.finishText();
    },
  };
  return section ? <input {...props} /> : <textarea {...props} />;
}

function SectionParts({
  id,
  section,
  selected,
  typing,
  on,
}: {
  id: string;
  section: SectionRecord;
  selected: boolean;
  typing: boolean;
  on: NodeEvents;
}) {
  return (
    <>
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <div
          key={side}
          className={`boxes-section-edge boxes-section-${side}`}
          data-movable={selected && side !== "top" ? "" : undefined}
          onPointerDown={(event) =>
            selected && side !== "top" ? on.move(event, id) : on.select(event, id)
          }
        />
      ))}
      {!typing && (
        <div
          className="boxes-section-title"
          style={{ left: titleOffset(section, titleWidth(section)) }}
          onPointerDown={(event) => (selected ? on.title(event, id) : on.select(event, id))}
        >
          {section.text || "Section"}
        </div>
      )}
    </>
  );
}

/** A box or section in the editor, with its text, strips and resize handles. */
export const BoxNode = memo(function BoxNode({
  id,
  area,
  selected,
  highlighted,
  typing,
  target,
  tools,
  on,
}: {
  id: string;
  area: Area;
  selected: boolean;
  /** An agent changed it a moment ago. */
  highlighted: boolean;
  typing: boolean;
  /** Lit up as the place a connector being drawn will end. */
  target: boolean;
  /** Shows strips and handles: selected, editable, and no text or drawing in progress. */
  tools: boolean;
  on: NodeEvents;
}) {
  const section = area.type === "section";
  const classes = [
    "boxes-node",
    section ? "boxes-node-section" : `boxes-node-${area.kind ?? "box"}`,
    selected && "boxes-selected",
    target && "boxes-target",
    highlighted && "boxes-agent",
  ];
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={nameOf(area)}
      aria-pressed={selected}
      data-record-id={id}
      className={classes.filter(Boolean).join(" ")}
      style={{ left: area.x, top: area.y, width: area.w, height: area.h }}
      onPointerDown={section ? undefined : (event) => on.move(event, id)}
    >
      {section ? (
        <SectionParts id={id} section={area} selected={selected} typing={typing} on={on} />
      ) : (
        <>
          <svg className="boxes-node-outline" width={area.w} height={area.h} aria-hidden="true">
            <Outline box={area} />
          </svg>
          {!typing && area.text && <div className="boxes-label">{area.text}</div>}
        </>
      )}
      {typing && <TextField id={id} area={area} on={on} />}
      {tools &&
        !section &&
        (area.kind === "diamond" ? DIAMOND_EDGES : SIDES).map((strip, index) => (
          <div
            key={index}
            className="boxes-strip"
            title="Click or drag to connect"
            style={stripStyle(area, strip)}
            onPointerDown={(event) => on.connect(event, id, strip)}
          />
        ))}
      {tools &&
        (section ? SECTION_HANDLES : BOX_HANDLES).map((handle) => (
          <div
            key={handle}
            className="boxes-handle"
            data-handle={handle}
            style={{
              left: `${handle.includes("w") ? 0 : handle.includes("e") ? 100 : 50}%`,
              top: `${handle.includes("n") ? 0 : handle.includes("s") ? 100 : 50}%`,
              cursor: `${handle}-resize`,
            }}
            onPointerDown={(event) => on.resize(event, id, handle)}
          />
        ))}
    </div>
  );
});

/** Where on the box a strip press starts a connector. */
export function stripAnchor(box: BoxRecord, strip: Strip, p: { x: number; y: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (strip.side === "diamond") {
    const [[x1, y1], [x2, y2]] = [strip.from, strip.to];
    const ax = box.x + x1 * box.w;
    const ay = box.y + y1 * box.h;
    const dx = (x2 - x1) * box.w;
    const dy = (y2 - y1) * box.h;
    const t = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy));
    return { rx: x1 + (x2 - x1) * t, ry: y1 + (y2 - y1) * t };
  }
  return {
    rx: strip.side === "w" ? 0 : strip.side === "e" ? 1 : clamp((p.x - box.x) / box.w),
    ry: strip.side === "n" ? 0 : strip.side === "s" ? 1 : clamp((p.y - box.y) / box.h),
  };
}
