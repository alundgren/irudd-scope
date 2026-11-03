/**
 * Pan, zoom, section dragging and follow for the canvas viewport. It moves the rendered
 * canvas with a CSS transform and never re-renders React: screen position equals canvas
 * position × k + (x, y).
 */

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Following a change, or picking a section from the list, never zooms in past this. */
export const FOLLOW_ZOOM = 1.4;
/** The camera holds still this long after the person panned, zoomed or dragged. */
const INTERACTION_MS = 3_000;
const FIT_MARGIN = 48;
/** Room for the name label above a section frame. */
const LABEL_SPACE = 30;
const DRAG_THRESHOLD = 4;
const ANIMATION_MS = 500;

type Camera = { x: number; y: number; k: number };
type Rect = { x: number; y: number; w: number; h: number };
type PointerInput = {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
};
type Pointer =
  | { mode: "press"; id: number; startX: number; startY: number; target: EventTarget | null }
  | { mode: "pan"; id: number; lastX: number; lastY: number }
  | {
      mode: "drag";
      id: number;
      startX: number;
      startY: number;
      section: string;
      element: HTMLElement;
      origin: { x: number; y: number };
      moved: boolean;
    };

export type CameraHost = {
  present: () => boolean;
  /** Whether a block editor is open, which also holds the camera still. */
  editing: () => boolean;
  /** A click without movement on the canvas. */
  press: (target: EventTarget | null) => void;
  /** A section dragged by its name to a new canvas position. */
  drop: (section: string, x: number, y: number) => void;
  /** A change the camera did not move to because the person was busy. */
  skipped: (section: string) => void;
};

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A section frame and its name label, in canvas coordinates. */
function frameRect(element: HTMLElement): Rect {
  return {
    x: element.offsetLeft,
    y: element.offsetTop - LABEL_SPACE,
    w: element.offsetWidth,
    h: element.offsetHeight + LABEL_SPACE,
  };
}

export class CanvasCamera {
  viewport: HTMLDivElement | null = null;
  world: HTMLDivElement | null = null;
  private zoomLabel: HTMLSpanElement | null = null;
  private camera: Camera = { x: 0, y: 0, k: 1 };
  private pointer: Pointer | null = null;
  private lastInteraction = 0;
  private placed = false;
  private animation?: ReturnType<typeof setTimeout>;
  private readonly host: CameraHost;

  constructor(host: CameraHost) {
    this.host = host;
  }

  /** Shows the whole canvas once the viewport has a size; hidden tabs have none yet. */
  place() {
    if (this.placed || !this.viewport?.clientWidth) return;
    this.placed = true;
    if (this.world?.querySelector("[data-section]")) this.fitAll(false);
    else this.set({ x: 0, y: 0, k: 1 });
  }

  fitAll(animate = true) {
    const frames = this.frames().map(frameRect);
    const title = this.world?.querySelector<HTMLElement>(".mc-title");
    if (title)
      frames.push({
        x: title.offsetLeft,
        y: title.offsetTop,
        w: title.offsetWidth,
        h: title.offsetHeight,
      });
    if (!frames.length) return;
    const x = Math.min(...frames.map((rect) => rect.x));
    const y = Math.min(...frames.map((rect) => rect.y));
    const w = Math.max(...frames.map((rect) => rect.x + rect.w)) - x;
    const h = Math.max(...frames.map((rect) => rect.y + rect.h)) - y;
    this.fit({ x, y, w, h }, 1, animate);
  }

  showSection(id: string) {
    const element = this.section(id);
    if (element) this.fit(frameRect(element), FOLLOW_ZOOM, true);
  }

  /**
   * Moves to a changed section. Present zooms to fit it; otherwise the camera only pans,
   * or zooms out when the section does not fit. While the person is busy it stays put.
   */
  follow(id: string) {
    const element = this.section(id);
    const area = this.viewport;
    if (!element || !area) return;
    if (this.interacting()) return this.host.skipped(id);
    const rect = frameRect(element);
    if (this.host.present()) return this.fit(rect, FOLLOW_ZOOM, true);
    const { x, y, k } = this.camera;
    const visible =
      rect.x * k + x >= 0 &&
      rect.y * k + y >= 0 &&
      (rect.x + rect.w) * k + x <= area.clientWidth &&
      (rect.y + rect.h) * k + y <= area.clientHeight;
    if (!visible) this.fit(rect, k, true);
  }

  /** The element that shows the zoom percentage; Present unmounts it. */
  showZoomIn(label: HTMLSpanElement | null) {
    this.zoomLabel = label;
    if (label) label.textContent = `${Math.round(this.camera.k * 100)}%`;
  }

  zoomBy(factor: number) {
    const area = this.viewport;
    if (area) this.zoomAt(factor, area.clientWidth / 2, area.clientHeight / 2, true);
  }
  zoomReset() {
    this.zoomBy(1 / this.camera.k);
  }

  /** Outlines pinned sections that cover another section. */
  markOverlaps(dragged?: HTMLElement, rect?: Rect) {
    const frames = this.frames();
    const rects = frames.map((frame) => (frame === dragged && rect ? rect : frameRect(frame)));
    frames.forEach((frame, index) => {
      const pinned = frame.classList.contains("is-pinned") || frame === dragged;
      const hit =
        pinned && rects.some((other, at) => at !== index && overlaps(rects[index]!, other));
      frame.classList.toggle("is-overlapping", hit);
    });
  }

  /** Scroll pans; Command or Ctrl with scroll, and trackpad pinches, zoom at the pointer. */
  wheel = (event: WheelEvent) => {
    event.preventDefault();
    this.lastInteraction = Date.now();
    if (event.ctrlKey || event.metaKey) {
      const bounds = this.viewport!.getBoundingClientRect();
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      this.zoomAt(Math.exp(-step * 0.01), event.clientX - bounds.left, event.clientY - bounds.top);
    } else {
      const { x, y, k } = this.camera;
      this.set({ x: x - event.deltaX, y: y - event.deltaY, k });
    }
  };

  pointerDown(event: PointerInput) {
    if (event.button !== 0 || this.pointer) return;
    const target = event.target instanceof Element ? event.target : null;
    const frame = target?.closest("[data-section-handle]")?.closest<HTMLElement>("[data-section]");
    this.viewport?.setPointerCapture(event.pointerId);
    this.lastInteraction = Date.now();
    const start = { id: event.pointerId, startX: event.clientX, startY: event.clientY };
    this.pointer =
      frame && !this.host.present()
        ? {
            mode: "drag",
            ...start,
            section: frame.dataset.section!,
            element: frame,
            origin: { x: frame.offsetLeft, y: frame.offsetTop },
            moved: false,
          }
        : { mode: "press", ...start, target: event.target };
  }

  pointerMove(event: PointerInput): void {
    const current = this.pointer;
    if (!current || current.id !== event.pointerId) return;
    this.lastInteraction = Date.now();
    if (current.mode === "press") {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (distance < DRAG_THRESHOLD) return;
      this.pointer = { mode: "pan", id: current.id, lastX: current.startX, lastY: current.startY };
      this.viewport?.classList.add("is-panning");
      return this.pointerMove(event);
    }
    if (current.mode === "pan") {
      const { x, y, k } = this.camera;
      this.set({ x: x + event.clientX - current.lastX, y: y + event.clientY - current.lastY, k });
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      return;
    }
    const { k } = this.camera;
    const dx = (event.clientX - current.startX) / k;
    const dy = (event.clientY - current.startY) / k;
    if (!current.moved && Math.hypot(dx * k, dy * k) < DRAG_THRESHOLD) return;
    current.moved = true;
    current.element.style.translate = `${dx}px ${dy}px`;
    current.element.classList.add("is-dragging");
    const rect = frameRect(current.element);
    this.markOverlaps(current.element, { ...rect, x: rect.x + dx, y: rect.y + dy });
  }

  pointerUp(event: PointerInput) {
    const current = this.pointer;
    if (!current || current.id !== event.pointerId) return;
    this.release();
    if (current.mode === "press") return this.host.press(current.target);
    if (current.mode !== "drag" || !current.moved) return;
    const { k } = this.camera;
    // Sections stay at non-negative positions so the kept HTML can scroll to all of them.
    const x = Math.max(0, Math.round(current.origin.x + (event.clientX - current.startX) / k));
    const y = Math.max(0, Math.round(current.origin.y + (event.clientY - current.startY) / k));
    this.host.drop(current.section, x, y);
  }

  pointerCancel() {
    this.release();
    this.markOverlaps();
  }

  private release() {
    const current = this.pointer;
    this.pointer = null;
    this.lastInteraction = Date.now();
    this.viewport?.classList.remove("is-panning");
    if (current?.mode === "drag") {
      current.element.style.translate = "";
      current.element.classList.remove("is-dragging");
    }
  }

  private interacting() {
    return (
      this.pointer !== null ||
      this.host.editing() ||
      Date.now() - this.lastInteraction < INTERACTION_MS
    );
  }

  private frames() {
    return [...(this.world?.querySelectorAll<HTMLElement>("[data-section]") ?? [])];
  }
  private section(id: string) {
    return this.world?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
  }

  private set(next: Camera, animate = false) {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.k));
    this.camera = { x: next.x, y: next.y, k };
    const world = this.world;
    const area = this.viewport;
    if (!world || !area) return;
    clearTimeout(this.animation);
    world.classList.toggle("is-animating", animate);
    if (animate)
      this.animation = setTimeout(() => world.classList.remove("is-animating"), ANIMATION_MS);
    world.style.transform = `translate(${next.x}px, ${next.y}px) scale(${k})`;
    area.style.setProperty("--mc-zoom", String(k));
    area.style.setProperty("--mc-pan-x", `${next.x}px`);
    area.style.setProperty("--mc-pan-y", `${next.y}px`);
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(k * 100)}%`;
  }

  private zoomAt(factor: number, screenX: number, screenY: number, animate = false) {
    const { x, y, k } = this.camera;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    const canvasX = (screenX - x) / k;
    const canvasY = (screenY - y) / k;
    this.set({ x: screenX - canvasX * next, y: screenY - canvasY * next, k: next }, animate);
  }

  private fit(rect: Rect, maxK: number, animate: boolean) {
    const area = this.viewport;
    if (!area || rect.w <= 0 || rect.h <= 0) return;
    const k = Math.max(
      MIN_ZOOM,
      Math.min(
        maxK,
        (area.clientWidth - FIT_MARGIN * 2) / rect.w,
        (area.clientHeight - FIT_MARGIN * 2) / rect.h,
      ),
    );
    this.set(
      {
        x: area.clientWidth / 2 - (rect.x + rect.w / 2) * k,
        y: area.clientHeight / 2 - (rect.y + rect.h / 2) * k,
        k,
      },
      animate,
    );
  }
}
