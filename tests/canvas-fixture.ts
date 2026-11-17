import { expect } from "vite-plus/test";
import type { Page } from "@playwright/test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CardFrame = { title: string; x: number; y: number; w: number; h: number; z: string };
export type Camera = { x: number; y: number; zoom: number };

export async function newCanvas(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search artifacts", { exact: true }).fill("canvas");
  await page.getByRole("button", { name: "New canvas", exact: true }).click();
  await page.getByRole("tab", { name: "Untitled canvas", selected: true }).waitFor();
  const field = pane(page).getByLabel("Canvas name", { exact: true });
  await field.fill(name);
  await field.press("Enter");
  await page.getByRole("tab", { name, selected: true }).waitFor();
  return (await page.getByRole("tab", { name }).getAttribute("id"))!.slice(4);
}

/** The selected tab's panel; other canvases stay mounted but hidden. */
export const pane = (page: Page) => page.locator('[role="tabpanel"]:not([hidden])');

export const board = (page: Page, tabId: string) =>
  page.evaluate(async (id) => (await window.scope.canvasRead(id))!.board.cards, tabId) as Promise<
    Record<string, CardFrame>
  >;

/** Adds boxes cards through the canvas bridge, the way the board does, and waits for them. */
export async function seedCards(
  page: Page,
  tabId: string,
  frames: readonly Omit<CardFrame, "z">[],
): Promise<string[]> {
  const ids = await page.evaluate(
    async ({ tabId, frames }) => {
      const read = await window.scope.canvasRead(tabId);
      const result = await window.scope.canvasChange({
        tabId,
        requestId: crypto.randomUUID().replaceAll("-", ""),
        target: { board: true },
        base: read!.board.version,
        label: "Seed cards",
        ops: frames.map((frame, index) => ({
          op: "put" as const,
          id: `$c${index}`,
          value: { type: "boxes", ...frame, z: `a${String(index).padStart(3, "0")}` },
        })),
      });
      if (!result.ok) throw new Error(result.message);
      return frames.map((_frame, index) => result.refs[`$c${index}`]);
    },
    { tabId, frames },
  );
  for (const frame of frames)
    await page.getByRole("group", { name: frame.title, exact: true }).waitFor();
  return ids;
}

export async function camera(page: Page, tabId: string): Promise<Camera | undefined> {
  return page.evaluate(
    async (id) =>
      (await window.scope.workspace())?.tabs.find((tab) => tab.id === id)?.state.data.camera as
        | Camera
        | undefined,
    tabId,
  );
}

/** Waits until the saved camera differs from `before`, then until it settles. */
export async function changedCamera(page: Page, tabId: string, before: Camera): Promise<Camera> {
  await expect
    .poll(async () => JSON.stringify(await camera(page, tabId)))
    .not.toBe(JSON.stringify(before));
  return settledCamera(page, tabId);
}

/** Waits until the saved camera stops changing and returns it. */
export async function settledCamera(page: Page, tabId: string): Promise<Camera> {
  let last = "";
  await expect
    .poll(
      async () => {
        const next = JSON.stringify(await camera(page, tabId));
        const same = next === last;
        last = next;
        return same && next !== undefined;
      },
      { interval: 400 },
    )
    .toBe(true);
  return JSON.parse(last);
}

export function historyCount(settingsDirectory: string, tabId: string): number {
  const db = new DatabaseSync(join(settingsDirectory, "artifacts/scope.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return Number(
      db.prepare("SELECT count(*) AS n FROM canvas_history WHERE tab_id = ?").get(tabId)?.n,
    );
  } finally {
    db.close();
  }
}

export async function drag(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
  during?: () => Promise<void>,
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await during?.();
  await page.mouse.up();
}

export async function center(page: Page, selector: ReturnType<Page["locator"]>) {
  const box = (await selector.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export type Content = Record<string, Record<string, unknown> & { type: string }>;

export const cardContent = (page: Page, tabId: string, cardId: string) =>
  page.evaluate(
    async ({ tabId, cardId }) => (await window.scope.canvasRead(tabId))!.cards[cardId]?.content,
    { tabId, cardId },
  ) as Promise<Content>;

export function cardHistory(settingsDirectory: string, tabId: string, scope: string): number {
  const db = new DatabaseSync(join(settingsDirectory, "artifacts/scope.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return Number(
      db
        .prepare("SELECT count(*) AS n FROM canvas_history WHERE tab_id = ? AND scope = ?")
        .get(tabId, scope)?.n,
    );
  } finally {
    db.close();
  }
}

/** Opens a card's editor from the board by double-clicking its picture. */
export async function openCard(page: Page, title: string) {
  await pane(page)
    .getByRole("group", { name: title, exact: true })
    .locator(".canvas-card-body")
    .dblclick();
  await pane(page).getByRole("heading", { name: title, exact: true }).waitFor();
}

/** Screen point of a content point in the open editor, at the editor's camera. */
export async function editorPoint(page: Page, x: number, y: number) {
  const surface = pane(page).getByLabel("Diagram canvas", { exact: true });
  const box = (await surface.boundingBox())!;
  const camera = await page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>(
      '[role="tabpanel"]:not([hidden]) .boxes-surface .canvas-layer',
    )!;
    const match = /scale\(([^)]+)\) translate\(([^p]+)px, ([^p]+)px\)/.exec(layer.style.transform)!;
    return { zoom: Number(match[1]), x: -Number(match[2]), y: -Number(match[3]) };
  });
  return { x: box.x + (x - camera.x) * camera.zoom, y: box.y + (y - camera.y) * camera.zoom };
}

export const records = (content: Content, type: string) =>
  Object.entries(content).filter(([, record]) => record.type === type);

/** Writes ops to a card the way the editor does, and returns the new IDs for `$` names. */
export async function seedContent(
  page: Page,
  tabId: string,
  cardId: string,
  label: string,
  ops: readonly { op: "put" | "set"; id: string; value?: object; fields?: object }[],
) {
  return page.evaluate(
    async ({ tabId, cardId, label, ops }) => {
      const read = await window.scope.canvasRead(tabId);
      const result = await window.scope.canvasChange({
        tabId,
        requestId: crypto.randomUUID().replaceAll("-", ""),
        target: { card: cardId },
        base: read!.cards[cardId].version,
        label,
        ops: ops as never,
      });
      if (!result.ok) throw new Error(result.message);
      return result.refs;
    },
    { tabId, cardId, label, ops },
  );
}
