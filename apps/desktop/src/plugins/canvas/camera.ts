import { useEffect, useRef, type RefObject } from "react";
import type { CanvasCamera } from "./contract.ts";

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
const STEP = 1.25;
const FIT_PADDING = 48;

export type Bounds = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Zooms so the board point under `screen` stays under it. */
export function zoomAt(camera: CanvasCamera, screen: Point, zoom: number): CanvasCamera {
  const next = clampZoom(zoom);
  return {
    zoom: next,
    x: camera.x + screen.x / camera.zoom - screen.x / next,
    y: camera.y + screen.y / camera.zoom - screen.y / next,
  };
}

export function zoomStep(camera: CanvasCamera, view: Bounds, direction: 1 | -1): CanvasCamera {
  return zoomAt(
    camera,
    { x: view.w / 2, y: view.h / 2 },
    direction > 0 ? camera.zoom * STEP : camera.zoom / STEP,
  );
}

/** A camera that shows all of `bounds` in a view of the given size, at most at 100%. */
export function fit(bounds: Bounds | undefined, view: Bounds, maxZoom = 1): CanvasCamera {
  if (!bounds) return { x: -FIT_PADDING, y: -FIT_PADDING, zoom: 1 };
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (view.w - FIT_PADDING * 2) / Math.max(1, bounds.w),
      (view.h - FIT_PADDING * 2) / Math.max(1, bounds.h),
    ),
  );
  return {
    zoom,
    x: bounds.x + bounds.w / 2 - view.w / 2 / zoom,
    y: bounds.y + bounds.h / 2 - view.h / 2 / zoom,
  };
}

export function boundsOf(frames: readonly Bounds[]): Bounds | undefined {
  if (!frames.length) return undefined;
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.w));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function wheelCamera(camera: CanvasCamera, event: WheelEvent, box: DOMRect): CanvasCamera {
  // Pinching a trackpad arrives as a wheel event with ctrlKey set.
  if (event.ctrlKey || event.metaKey)
    return zoomAt(
      camera,
      { x: event.clientX - box.left, y: event.clientY - box.top },
      camera.zoom * Math.exp(-event.deltaY / 200),
    );
  // A mouse wheel with Shift held scrolls sideways.
  const sideways = event.shiftKey && event.deltaX === 0;
  const dx = sideways ? event.deltaY : event.deltaX;
  const dy = sideways ? 0 : event.deltaY;
  return { ...camera, x: camera.x + dx / camera.zoom, y: camera.y + dy / camera.zoom };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/**
 * Figma-style camera gestures for a surface: scroll pans, pinch and Ctrl/Cmd+scroll zoom at the
 * pointer, Space+drag and middle-button drag pan, and Ctrl/Cmd with plus or minus zooms around
 * the view's center. The board and the card editor share them. While Space or Ctrl/Cmd is held
 * the surface's `data-camera` says so, and the stylesheet shows a grab or zoom cursor.
 */
export function useCameraControls(
  surface: RefObject<HTMLElement | null>,
  camera: CanvasCamera,
  onCamera: (camera: CanvasCamera) => void,
  active: boolean,
) {
  const latest = useRef({ camera, onCamera });
  latest.current = { camera, onCamera };

  useEffect(() => {
    const element = surface.current;
    if (!element || !active) return;
    let space = false;
    let zoom = false;
    // A drag with Ctrl held turns card snapping off, so it keeps its own cursor.
    let pressed = false;
    let pan: { x: number; y: number; camera: CanvasCamera } | undefined;
    const show = () => {
      const mode = pan ? "panning" : space ? "pan" : zoom && !pressed ? "zoom" : undefined;
      if (mode === element.dataset.camera) return;
      if (mode) element.dataset.camera = mode;
      else delete element.dataset.camera;
    };
    const modifiers = (event: KeyboardEvent | PointerEvent) => {
      zoom = event.ctrlKey || event.metaKey;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const { camera, onCamera } = latest.current;
      onCamera(wheelCamera(camera, event, element.getBoundingClientRect()));
    };
    const keyDown = (event: KeyboardEvent) => {
      modifiers(event);
      if (event.key === " " && !isTyping(event.target)) space = true;
      show();
      if (isTyping(event.target)) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const direction = ["+", "="].includes(event.key) ? 1 : event.key === "-" ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const { camera, onCamera } = latest.current;
      onCamera(zoomStep(camera, { x: 0, y: 0, w: box.width, h: box.height }, direction));
    };
    const keyUp = (event: KeyboardEvent) => {
      modifiers(event);
      if (event.key === " ") space = false;
      show();
    };
    const reset = () => {
      space = false;
      zoom = false;
      pressed = false;
      pan = undefined;
      show();
    };
    const pointerDown = (event: PointerEvent) => {
      pressed = true;
      if (event.button !== 1 && !(event.button === 0 && space)) return show();
      event.preventDefault();
      event.stopPropagation();
      element.setPointerCapture(event.pointerId);
      pan = { x: event.clientX, y: event.clientY, camera: latest.current.camera };
      show();
    };
    const pointerMove = (event: PointerEvent) => {
      modifiers(event);
      pressed = event.buttons !== 0;
      show();
      if (!pan) return;
      const { zoom } = pan.camera;
      latest.current.onCamera({
        zoom,
        x: pan.camera.x - (event.clientX - pan.x) / zoom,
        y: pan.camera.y - (event.clientY - pan.y) / zoom,
      });
    };
    const pointerUp = () => {
      pan = undefined;
      pressed = false;
      show();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    // Capture so Space+drag pans even when it starts on a card.
    element.addEventListener("pointerdown", pointerDown, { capture: true });
    element.addEventListener("pointermove", pointerMove);
    element.addEventListener("pointerup", pointerUp);
    element.addEventListener("pointercancel", pointerUp);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", reset);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", pointerDown, { capture: true });
      element.removeEventListener("pointermove", pointerMove);
      element.removeEventListener("pointerup", pointerUp);
      element.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", reset);
      reset();
    };
  }, [surface, active]);
}
