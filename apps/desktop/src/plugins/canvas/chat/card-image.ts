import { BrowserWindow } from "electron";
import type { CardContent } from "../contract.ts";

const PAGE = "scope://app/card-image.html";
/** The longest side of a picture, in pixels. Larger cards are scaled down to fit. */
export const IMAGE_SIDE = 1600;
const MARGIN = 24;
const WAIT = 15_000;
/** The hidden window stays this long after the last picture, so a chat's reads reuse it. */
const IDLE = 5 * 60_000;

/** What the image page reports after drawing a card. `left` and `top` are card coordinates. */
export type DrawnCard = { width: number; height: number; scale: number; left: number; top: number };

/** A picture of a whole card as base64 PNG, with how its pixels map to card coordinates. */
export type CardImage = DrawnCard & { png: string };

/**
 * Draws cards as the editor shows them, in one hidden offscreen window that loads Scope's
 * image page with no preload, and captures them as PNG through the window's DevTools
 * protocol. Calls take turns in that window.
 */
export function cardImages() {
  let window: BrowserWindow | undefined;
  let loaded: Promise<unknown> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  function drop() {
    clearTimeout(idle);
    if (window && !window.isDestroyed()) window.destroy();
    window = undefined;
    loaded = undefined;
  }

  function open() {
    if (window && !window.isDestroyed() && loaded) return { window, loaded };
    const created = new BrowserWindow({
      show: false,
      width: IMAGE_SIDE,
      height: IMAGE_SIDE,
      frame: false,
      skipTaskbar: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => {
      if (event.url !== PAGE) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("render-process-gone", () => {
      if (window === created) drop();
    });
    window = created;
    loaded = contents.loadURL(PAGE);
    return { window: created, loaded };
  }

  async function capture(type: string, content: CardContent): Promise<CardImage | null> {
    const { window, loaded } = open();
    await loaded;
    const devtools = window.webContents.debugger;
    if (!devtools.isAttached()) {
      devtools.attach("1.3");
      // The window manager can shrink a hidden window to the screen, and a high-density
      // display doubles its pixels; a fixed page size and density keep pictures the same.
      await devtools.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: IMAGE_SIDE,
        height: IMAGE_SIDE,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    // JSON is a valid JavaScript expression, so the card's text cannot become code here.
    const drawn = (await window.webContents.executeJavaScript(
      `drawCard(${JSON.stringify(type)}, ${JSON.stringify(content)}, ${IMAGE_SIDE}, ${MARGIN})`,
    )) as DrawnCard | null;
    if (!drawn) return null;
    const shot = (await devtools.sendCommand("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: drawn.width, height: drawn.height, scale: 1 },
      captureBeyondViewport: true,
    })) as { data?: string };
    return shot.data ? { ...drawn, png: shot.data } : null;
  }

  return {
    /** A picture of the card's content, or null when it has nothing to draw or drawing failed. */
    draw(type: string, content: CardContent): Promise<CardImage | null> {
      if (closed) return Promise.resolve(null);
      const turn = queue.then(async () => {
        clearTimeout(idle);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            capture(type, content),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Drawing the card took too long.")), WAIT);
            }),
          ]);
        } catch {
          // A stuck or broken page is replaced on the next call.
          drop();
          return null;
        } finally {
          clearTimeout(timer);
          if (window) idle = setTimeout(drop, IDLE);
        }
      });
      queue = turn;
      return turn;
    },
    close() {
      closed = true;
      drop();
    },
  };
}

export type CardImages = ReturnType<typeof cardImages>;
