import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { CardContent } from "../plugins/canvas/contract.ts";
import type { DrawnCard } from "../plugins/canvas/chat/card-image.ts";
import { findCardView } from "../plugins/canvas/cards/views.ts";
import "./style.css";
import "./card-image.css";

// Main loads this page in a hidden offscreen window with no preload, calls drawCard through
// executeJavaScript and captures the window. The page can reach nothing in Scope.
const root = createRoot(document.getElementById("root")!);
const layer = () => document.querySelector<HTMLElement>(".card-image-layer")!;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function drawCard(
  type: string,
  content: CardContent,
  side: number,
  margin: number,
): Promise<DrawnCard | null> {
  const image = findCardView(type)?.Image;
  if (!image) return null;
  flushSync(() =>
    root.render(
      <div className="card-image-layer">
        <image.Layer content={content} />
      </div>,
    ),
  );
  await document.fonts.ready;
  // Drawn at scale 1 from the page's corner, so element edges are card coordinates.
  layer().style.transform = "none";
  const rects = [...layer().querySelectorAll(image.parts)]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 || rect.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const w = Math.max(...rects.map((rect) => rect.right)) - left;
  const h = Math.max(...rects.map((rect) => rect.bottom)) - top;
  const scale = Math.min(1, (side - 2 * margin) / Math.max(w, h, 1));
  const edge = margin / scale;
  layer().style.transform = `scale(${scale}) translate(${edge - left}px, ${edge - top}px)`;
  await frame();
  await frame();
  return {
    width: Math.min(side, Math.ceil(w * scale + 2 * margin)),
    height: Math.min(side, Math.ceil(h * scale + 2 * margin)),
    scale,
    left: left - edge,
    top: top - edge,
  };
}

Object.assign(window, { drawCard });
