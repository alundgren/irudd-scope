import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../../../renderer/components/ui/button.tsx";
import { useCameraControls } from "../../camera.ts";
import type { CardEditorProps } from "../views.ts";
import { nameOf, stripAnchor, type NodeEvents } from "./box-node.tsx";
import {
  BOX_KINDS,
  type Area,
  type BoxKind,
  type BoxesContent,
  type ConnectorRecord,
} from "./contract.ts";
import type { LineEvents } from "./connector-layer.tsx";
import { ArrowControlsAt, KindPicker, UndoBar, hint } from "./controls.tsx";
import { DiagramLayer } from "./diagram-layer.tsx";
import { draftOps, withDraft, type Draft } from "./draft.ts";
import { editorKey } from "./editor-keys.ts";
import { deletion, orderAbove, toggleArrow, useLatest, useStable } from "./editor-tools.ts";
import { connectorEnds, createsBox, dragTo, ghostOf, type Gesture } from "./gestures.ts";
import { GRID, anchorAt, contained, resolve, type Guide, type Point } from "./geometry.ts";
import "./style.css";

const DOUBLE_CLICK = 400;
type Typing = { id: string; label: string };

/** The boxes and arrows editor: every finished gesture is one change to the card. */
export function BoxesEditor({
  content: raw,
  editable,
  active,
  camera,
  onCamera,
  write,
  step,
  newId,
}: CardEditorProps) {
  const content = raw as BoxesContent;
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft, draftRef] = useLatest<Draft>({});
  const [gesture, setGesture, gestureRef] = useLatest<Gesture | undefined>(undefined);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [selected, setSelected] = useState<string>();
  const [typing, setTyping, typingRef] = useLatest<Typing | undefined>(undefined);
  const [labeling, setLabeling, labelingRef] = useLatest<string | undefined>(undefined);
  const [details, setDetails] = useState<string>();
  const [drawingSection, setDrawingSection] = useState(false);
  const [undoBar, setUndoBar] = useState<string>();
  const lastClick = useRef({ id: "", time: 0 });
  const view = useMemo(() => withDraft(content, draft), [content, draft]);
  const latest = useRef({ content, view, camera });
  latest.current = { content, view, camera };
  useCameraControls(surface, camera, onCamera, active);

  useEffect(() => {
    if (!undoBar) return;
    const timer = setTimeout(() => setUndoBar(undefined), 6000);
    return () => clearTimeout(timer);
  }, [undoBar]);
  useEffect(() => {
    if (selected && !view[selected]) setSelected(undefined);
  }, [view, selected]);
  // Leaving the editor while typing keeps what was typed.
  useEffect(() => () => commit(typingRef.current?.label ?? "Edit text"), []);

  const zOrder = () => orderAbove(latest.current.view);
  function toContent(event: { clientX: number; clientY: number }): Point {
    const box = surface.current!.getBoundingClientRect();
    const { camera } = latest.current;
    return {
      x: camera.x + (event.clientX - box.left) / camera.zoom,
      y: camera.y + (event.clientY - box.top) / camera.zoom,
    };
  }
  function commit(label: string, next = draftRef.current) {
    const ops = draftOps(latest.current.content, next);
    if (ops.length) write(label, ops);
    setDraft({});
  }
  function finishTyping() {
    if (typingRef.current) commit(typingRef.current.label);
    if (labelingRef.current) commit("Label connector");
    setTyping(undefined);
    setLabeling(undefined);
  }
  function begin(event: PointerEvent, next: Gesture) {
    event.stopPropagation();
    finishTyping();
    surface.current?.focus({ preventScroll: true });
    surface.current?.setPointerCapture(event.pointerId);
    setGesture(next);
  }
  function cancel() {
    setGesture(undefined);
    setGuides([]);
    setDraft({});
    lastClick.current = { id: "", time: 0 };
  }
  function startTyping(id: string) {
    const record = latest.current.content[id] as Area;
    setSelected(id);
    setTyping({
      id,
      label: record.type === "section" ? `Rename ${nameOf(record)}` : `Edit ${nameOf(record)}`,
    });
  }

  const node: NodeEvents = {
    select(event, id) {
      event.stopPropagation();
      event.preventDefault();
      finishTyping();
      setSelected(id);
    },
    move(event, id) {
      if (event.button !== 0) return;
      if (!editable) return node.select(event, id);
      const area = latest.current.view[id] as Area;
      setSelected(id);
      const ids =
        area.type === "section" ? [id, ...contained(id, area, latest.current.view)] : [id];
      const origin = Object.fromEntries(
        ids.map((other) => [other, latest.current.view[other] as Area]),
      );
      begin(event, { kind: "move", id, start: toContent(event), origin, moved: false });
    },
    resize(event, id, handle) {
      if (event.button !== 0) return;
      begin(event, {
        kind: "resize",
        id,
        handle,
        start: toContent(event),
        origin: latest.current.view[id] as Area,
      });
    },
    connect(event, id, strip) {
      if (event.button !== 0) return;
      const box = latest.current.view[id];
      if (box?.type !== "box") return;
      const p = toContent(event);
      const at = stripAnchor(box, strip, p);
      const from = { id, ...at, ...resolve({ id, ...at }, box) };
      begin(event, {
        kind: "connect",
        from,
        candidate: from,
        start: p,
        waiting: false,
        moved: false,
      });
    },
    title(event, id) {
      if (event.button !== 0) return;
      event.preventDefault();
      const section = latest.current.view[id] as Area & { title?: number };
      begin(event, {
        kind: "title",
        id,
        start: toContent(event),
        original: section.title ?? 0,
        moved: false,
      });
    },
    text(id, text) {
      const record = draftRef.current[id] ?? latest.current.content[id];
      setDraft({ ...draftRef.current, [id]: { ...(record as Area), text: text || undefined } });
    },
    finishText: finishTyping,
  };
  const line: LineEvents = {
    select(event, id) {
      event.stopPropagation();
      event.preventDefault();
      finishTyping();
      setSelected(id);
      const now = Date.now();
      if (editable && lastClick.current.id === id && now - lastClick.current.time < DOUBLE_CLICK) {
        setLabeling(id);
        setDetails(id);
        lastClick.current = { id: "", time: 0 };
      } else lastClick.current = { id, time: now };
    },
    endpoint(event, id, which) {
      const connector = latest.current.view[id] as ConnectorRecord;
      const original = connector[which];
      const candidate = {
        ...original,
        ...resolve(original, latest.current.view[original.id] as Area & { type: "box" }),
      };
      begin(event, { kind: "endpoint", id, which, original, candidate });
    },
    label(id, text) {
      const record = draftRef.current[id] ?? latest.current.content[id];
      setDraft({
        ...draftRef.current,
        [id]: { ...(record as ConnectorRecord), label: text || undefined },
      });
    },
    finishLabel: finishTyping,
  };

  function finishClick(id: string) {
    const now = Date.now();
    if (lastClick.current.id === id && now - lastClick.current.time < DOUBLE_CLICK) {
      lastClick.current = { id: "", time: 0 };
      startTyping(id);
    } else lastClick.current = { id, time: now };
  }
  function finishConnect(g: Extract<Gesture, { kind: "connect" }>) {
    const { content, camera } = latest.current;
    if (g.start && !g.waiting && !g.moved) {
      setGesture({ ...g, waiting: true, start: undefined });
      return true;
    }
    const z = zOrder();
    const ghost = ghostOf(g, content, camera.zoom);
    const from = content[g.from.id] as Area;
    if (ghost) {
      // A box added from a connector almost always needs a label next, so it is saved with it.
      const id = newId();
      const box = { type: "box" as const, ...ghost.rect, z: z() };
      const middle = { id, rx: 0.5, ry: 0.5, x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const [start, end] = connectorEnds(g.from, middle, { ...content, [id]: box });
      setDraft({ [id]: box, [newId()]: { type: "connector", from: start, to: end, z: z() } });
      setSelected(id);
      setTyping({ id, label: `Add box after ${nameOf(from)}` });
    } else if (g.candidate.id && g.candidate.id !== g.from.id && !createsBox(g, camera.zoom)) {
      const target = content[g.candidate.id] as Area;
      const [start, end] = connectorEnds(g.from, { ...g.candidate, id: g.candidate.id }, content);
      const id = newId();
      commit(`Connect ${nameOf(from)} to ${nameOf(target)}`, {
        [id]: { type: "connector", from: start, to: end, z: z() },
      });
      setSelected(id);
    }
    return false;
  }
  function finish() {
    const g = gestureRef.current;
    if (!g) return;
    const { content } = latest.current;
    const record = "id" in g ? (content[g.id] ?? draftRef.current[g.id]) : undefined;
    const name = record && record.type !== "connector" ? nameOf(record) : "";
    if (g.kind === "connect" && finishConnect(g)) return;
    if ((g.kind === "move" || g.kind === "title") && !g.moved) {
      setDraft({});
      finishClick(g.id);
    } else if (g.kind === "move") commit(`Move ${name}`);
    else if (g.kind === "title") commit(`Move title of ${name}`);
    else if (g.kind === "resize") commit(`Resize ${name}`);
    else if (g.kind === "endpoint") commit("Reattach connector");
    else if (g.kind === "draw") {
      const drawn = draftRef.current[g.id] as Area | undefined;
      if (!drawn || drawn.w < GRID || drawn.h < GRID) setDraft({});
      else {
        commit(drawn.type === "section" ? "Add section" : "Add box");
        setSelected(g.id);
      }
    }
    setGesture(undefined);
    setGuides([]);
  }

  function surfaceDown(event: PointerEvent) {
    const g = gestureRef.current;
    if (g?.kind === "connect" && g.waiting) {
      event.preventDefault();
      event.stopPropagation();
      const p = toContent(event);
      setGesture({
        ...g,
        waiting: false,
        candidate: anchorAt(p, latest.current.view, camera.zoom),
      });
      finish();
      return;
    }
    if (event.button !== 0 || g) return;
    surface.current?.focus({ preventScroll: true });
    setSelected(undefined);
    setDetails(undefined);
    if (typingRef.current || labelingRef.current) return finishTyping();
    if (!editable) return;
    const p = toContent(event);
    const id = newId();
    const start = { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
    const record: Area = drawingSection
      ? { type: "section", ...start, w: 0, h: 0, text: "Section", z: zOrder()() }
      : { type: "box", ...start, w: 0, h: 0, z: zOrder()() };
    setDrawingSection(false);
    setSelected(id);
    begin(event, { kind: "draw", id, start, record });
  }
  function surfaceMove(event: PointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    const next = dragTo(g, toContent(event), latest.current.content, camera.zoom);
    setGesture(next.gesture);
    setDraft(next.draft);
    setGuides(next.guides);
  }
  // A connect drag that ends where it started waits for a second click instead of finishing.
  function surfaceUp() {
    finish();
  }

  function remove() {
    if (!selected || !view[selected]) return;
    const gone = deletion(view, selected);
    commit(gone.label, Object.fromEntries(gone.ids.map((id) => [id, null])));
    setSelected(undefined);
    setUndoBar(gone.text);
  }
  function nudge(id: string, dx: number, dy: number) {
    const area = view[id] as Area;
    const ids = area.type === "section" ? [id, ...contained(id, area, view)] : [id];
    const moved = (other: string) => {
      const item = view[other] as Area;
      return { ...item, x: item.x + dx, y: item.y + dy };
    };
    commit(`Move ${nameOf(area)}`, Object.fromEntries(ids.map((other) => [other, moved(other)])));
  }
  const nodeEvents = useStable(
    editable
      ? node
      : { ...node, move: node.select, title: node.select, resize: () => {}, connect: () => {} },
  );
  const lineEvents = useStable(line);
  const screen = (p: Point) => ({
    left: (p.x - camera.x) * camera.zoom,
    top: (p.y - camera.y) * camera.zoom,
  });
  const typed = typing ? (view[typing.id] as Area | undefined) : undefined;
  const chosen = selected ? view[selected] : undefined;
  return (
    <div className="boxes-editor">
      {editable && (
        <div className="boxes-toolbar" role="toolbar" aria-label="Diagram">
          <Button
            size="sm"
            variant={drawingSection ? "default" : "ghost"}
            aria-pressed={drawingSection}
            title="Draw a section"
            onClick={() => {
              finishTyping();
              setSelected(undefined);
              setDrawingSection(!drawingSection);
            }}
          >
            Section
          </Button>
          <Button size="sm" variant="ghost" disabled={!chosen} onClick={remove}>
            Delete selected
          </Button>
          <span className="boxes-hint" aria-live="polite">
            {hint({
              editable,
              drawingSection,
              gesture,
              typing: !!typing,
              labeling: !!labeling,
              selected,
              content: view,
            })}
          </span>
        </div>
      )}
      <div
        ref={surface}
        className={`boxes-surface${editable ? " boxes-surface-edit" : ""}`}
        tabIndex={0}
        aria-label="Diagram canvas"
        onPointerDownCapture={(event) => {
          const g = gestureRef.current;
          if (g?.kind === "connect" && g.waiting) surfaceDown(event);
        }}
        onPointerDown={surfaceDown}
        onPointerMove={surfaceMove}
        onPointerUp={surfaceUp}
        onPointerCancel={cancel}
        onKeyDown={(event) =>
          editorKey(event, {
            editable,
            busy: !!gestureRef.current,
            record: selected ? view[selected] : undefined,
            cancel,
            step,
            open: () => {
              if (view[selected!]?.type !== "connector") return startTyping(selected!);
              setLabeling(selected);
              setDetails(selected);
            },
            nudge: (dx, dy) => nudge(selected!, dx, dy),
            remove,
          })
        }
      >
        <div
          className="canvas-layer"
          style={{ transform: `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)` }}
        >
          <DiagramLayer
            view={view}
            content={latest.current.content}
            selected={selected}
            typing={typing?.id}
            labeling={labeling}
            gesture={gesture}
            guides={guides}
            zoom={camera.zoom}
            editable={editable}
            node={nodeEvents}
            line={lineEvents}
          />
        </div>
        {!Object.keys(view).length && (
          <p className="canvas-empty">{editable ? "Drag to draw a box" : "Empty diagram"}</p>
        )}
        {editable && typed?.type === "box" && !gesture && (
          <KindPicker
            style={screen({ x: typed.x, y: typed.y + typed.h + 24 / camera.zoom })}
            current={typed.kind ?? "box"}
            onPick={(kind: BoxKind) => {
              const label = typing!.label.startsWith("Add")
                ? typing!.label
                : `Change ${nameOf(typed)} to ${BOX_KINDS.find((k) => k.id === kind)!.label}`;
              const next = {
                ...draftRef.current,
                [typing!.id]: { ...typed, kind: kind === "box" ? undefined : kind },
              };
              commit(label, next);
              setTyping(undefined);
              surface.current?.focus({ preventScroll: true });
            }}
          />
        )}
        {editable && chosen?.type === "connector" && details === selected && !gesture && (
          <ArrowControlsAt
            connector={chosen}
            view={view}
            screen={screen}
            onToggle={(end) => {
              const toggled = toggleArrow(chosen, end);
              commit(toggled.label, { [selected!]: { ...chosen, [end]: toggled.value } });
            }}
          />
        )}
        {undoBar && (
          <UndoBar
            text={undoBar}
            onUndo={() => step("undo")}
            onClose={() => setUndoBar(undefined)}
          />
        )}
      </div>
    </div>
  );
}
