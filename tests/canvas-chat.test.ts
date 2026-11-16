import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import type { ElectronApplication, Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";
import { newCanvas, openCard, pane, seedCards } from "./canvas-fixture.ts";

// Whether the window shows its chat view; hiding it leaves the page loaded and still "visible".
const chatShown = (application: ElectronApplication) =>
  application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) =>
      window.contentView.children.some(
        (view) =>
          "webContents" in view &&
          (view as Electron.WebContentsView).webContents.getURL() === "scope://app/chat.html" &&
          view.getVisible(),
      ),
    ),
  );
const chatPage = (application: ElectronApplication) =>
  application.windows().find((page) => page.url() === "scope://app/chat.html");

async function setCardChat(page: Page, enabled: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Search settings").fill("card chat");
  const toggle = page.getByRole("switch", { name: "Card chat", exact: true });
  await toggle.focus();
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled))
    await page.keyboard.press("Space");
  await expect.poll(() => toggle.getAttribute("aria-checked")).toBe(String(enabled));
  await page.keyboard.press("Escape");
  await page.getByLabel("Search settings").waitFor({ state: "detached" });
}

test(
  "card chat is off until switched on, then sits beside the card editor in its own page",
  { tags: ["survives-restart"], timeout: 240_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Chat");
      await seedCards(page, tabId, [{ title: "Order flow", x: 0, y: 0, w: 640, h: 400 }]);
      await openCard(page, "Order flow");
      expect(await page.evaluate(() => window.scope.settings())).toMatchObject({
        cardChatEnabled: false,
      });
      expect(await pane(page).locator(".canvas-chat-slot").count()).toBe(0);
      expect(chatPage(application)).toBeUndefined();

      await setCardChat(page, true);
      const slot = pane(page).locator(".canvas-chat-slot");
      await slot.waitFor();
      await expect.poll(() => chatPage(application) !== undefined).toBe(true);
      const chat = chatPage(application)!;
      await chat.getByRole("heading", { name: "Chat", exact: true }).waitFor();
      await chat.getByText("Scope can't find Claude Code or Codex on this computer.").waitFor();
      expect(await chat.getByLabel("Message", { exact: true }).isDisabled()).toBe(true);
      // The chat page fills the room the editor keeps for it.
      const room = (await slot.boundingBox())!;
      await expect
        .poll(() => chat.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([Math.round(room.width), Math.round(room.height)]);
      await expect.poll(() => chatShown(application)).toBe(true);
      // Each page reaches only its own bridge.
      expect(await page.evaluate(() => "scopeChat" in window)).toBe(false);
      expect(await chat.evaluate(() => "scope" in window)).toBe(false);

      // Back on the board there is no editor, so the chat steps away.
      await page.keyboard.press("Escape");
      await slot.waitFor({ state: "detached" });
      await expect.poll(() => chatShown(application)).toBe(false);

      // The switch comes back after a restart, and the panel with the reopened card.
      await openCard(page, "Order flow");
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      await pane(page).locator(".canvas-chat-slot").waitFor();
      await expect.poll(() => chatPage(application) !== undefined).toBe(true);
      await expect.poll(() => chatShown(application)).toBe(true);

      // Off again hides it.
      await setCardChat(page, false);
      expect(await pane(page).locator(".canvas-chat-slot").count()).toBe(0);
      await expect.poll(() => chatShown(application)).toBe(false);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
