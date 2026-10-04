import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import type { Locator } from "@playwright/test";

const html = `<!doctype html><html><head><title>Marking plan</title><style>body{margin:0;background:#f3f8f1;color:#182a21;font:18px system-ui}section{height:400px;padding:24px}button{font:inherit}</style></head><body><section>Introduction</section><section><button onclick="this.textContent='Clicked'">Interactive target</button></section><section>More content</section><section>End</section></body></html>`;
const evidence = "/tmp/scope-plan-ui-evidence";

async function expectPinTracksScroll(pin: Locator) {
  const samples = await pin.evaluate(async (button) => {
    const layer = button.closest(".plan-pin-layer")!;
    const circle = layer.querySelector("circle")!;
    const documentWindow = layer.parentElement!.querySelector("iframe")!.contentWindow!;
    const start = documentWindow.scrollY;
    const samples = [];
    for (const offset of [0, 8, 16, 24, 32, 40, 32, 24, 16, 8, 0]) {
      documentWindow.scrollTo(0, start + offset);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const buttonBounds = button.getBoundingClientRect();
      const circleBounds = circle.getBoundingClientRect();
      const x = circleBounds.x + circleBounds.width / 2;
      const y = circleBounds.y + circleBounds.height / 2;
      samples.push({
        xError: Math.abs(buttonBounds.x + buttonBounds.width / 2 - x),
        yError: Math.abs(buttonBounds.y + buttonBounds.height / 2 - y),
        y,
      });
    }
    return samples;
  });
  expect(Math.max(...samples.map((sample) => sample.yError))).toBeLessThan(1);
  expect(Math.max(...samples.map((sample) => sample.xError))).toBeLessThan(1);
  expect(samples[0].y - Math.min(...samples.map((sample) => sample.y))).toBeGreaterThan(30);
  expect(samples.at(-1)!.y).toBeCloseTo(samples[0].y, 0);
}

test("comment pins stay beside the page content through scrolling and restart with a compact editor", async () => {
  const { directory, launch, connect } = await desktopFixture({
    showWindow: process.platform === "darwin",
  });
  let application = await launch();
  try {
    await mkdir(evidence, { recursive: true });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 760),
    );
    let page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(
      (html) => window.scope.createPlan({ name: "marking-plan", title: "Marking plan", html }),
      html,
    );
    let frame = page.frameLocator(".plan-document");
    await frame.getByRole("button", { name: "Interactive target" }).waitFor();
    await frame
      .locator("body")
      .evaluate((body) => body.ownerDocument.defaultView!.scrollTo(0, 300));
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const screenshot = page.getByRole("img", {
      name: "Frozen plan screenshot, draw annotations here",
    });
    await screenshot.waitFor();
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).count()).toBe(0);
    expect(await page.locator(".plan-capture .plan-pin-popover").count()).toBe(0);
    expect(await screenshot.locator("circle").count()).toBe(0);
    expect(await screenshot.evaluate((element) => getComputedStyle(element).cursor)).toBe(
      "crosshair",
    );
    await page.screenshot({ path: join(evidence, "pin-placement-light.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Resume comment", exact: true }).click();
    await screenshot.waitFor();
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Box", exact: true }).count()).toBe(0);
    const screenshotBounds = (await screenshot.boundingBox())!;
    const pageBounds = (await page.locator(".plan-document").boundingBox())!;
    expect(screenshotBounds.height).toBeCloseTo(pageBounds.height, 0);
    const workspace = await page.evaluate(() => window.scope.workspace());
    const tab = workspace!.tabs.find((entry) => entry.type === "plan")!;
    await expect
      .poll(() => page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id))
      .not.toBeNull();
    const draft = (await page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id))!;
    expect(draft.annotations).toEqual([]);
    const capturePixel = await application.evaluate(({ nativeImage }, bytes) => {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes, "base64"));
      const size = image.getSize();
      const offset =
        (Math.floor(size.height * 0.04) * size.width + Math.floor(size.width * 0.93)) * 4;
      return [...image.toBitmap().subarray(offset, offset + 3)];
    }, draft.image);
    expect(capturePixel).toEqual([241, 248, 243]);
    await page.mouse.click(screenshotBounds.x + 200, screenshotBounds.y + 150);
    const editor = (await page.locator(".plan-capture .plan-pin-popover").boundingBox())!;
    expect(editor.x).toBeGreaterThan(screenshotBounds.x + 200);
    expect(editor.y).toBeLessThan(screenshotBounds.y + 150);
    expect(editor.height).toBeLessThan(200);
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Clarify this section.");
    await page.screenshot({ path: join(evidence, "pin-editor-light.png") });
    await page.getByRole("button", { name: "Back to plan", exact: true }).click();
    await expectPinTracksScroll(
      page.getByRole("button", { name: "Open draft comment", exact: true }),
    );
    await page.getByRole("button", { name: "Open draft comment", exact: true }).click();
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (1)", exact: true }).waitFor();
    expect(await page.getByRole("complementary", { name: "Plan feedback" }).count()).toBe(0);
    let pin = page.getByRole("button", { name: "Comment: Clarify this section.", exact: true });
    await pin.click();
    await page
      .getByRole("region", { name: "Pinned comment: Clarify this section.", exact: true })
      .waitFor();
    await page.screenshot({ path: join(evidence, "pin-comment-light.png") });
    await page.getByRole("button", { name: "Close comment", exact: true }).click();
    await expectPinTracksScroll(pin);
    const before = (await pin.boundingBox())!;
    await frame
      .locator("body")
      .evaluate((body) => body.ownerDocument.defaultView!.scrollTo(0, 340));
    await expect.poll(async () => (await pin.boundingBox())!.y).toBeCloseTo(before.y - 40, 0);
    await frame.getByRole("button", { name: "Interactive target" }).click();
    await frame.getByRole("button", { name: "Clicked", exact: true }).waitFor();
    await application.close();
    application = await launch();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 760),
    );
    page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    frame = page.frameLocator(".plan-document");
    await frame.getByRole("button", { name: "Interactive target" }).waitFor();
    const client = await connect();
    const saved = await client.plan({ action: "read", name: "marking-plan" });
    if (saved.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(saved.snapshot.comments[0].viewport).toMatchObject({
      scrollX: 0,
      scrollY: 300,
      width: 1000,
    });
    expect(saved.snapshot.comments[0].annotations[0].type).toBe("pin");
    pin = page.getByRole("button", { name: "Comment: Clarify this section.", exact: true });
    await pin.click();
    const thread = page.getByRole("region", {
      name: "Pinned comment: Clarify this section.",
      exact: true,
    });
    await thread.getByRole("button", { name: "Copy agent request", exact: true }).click();
    await thread.getByRole("button", { name: "Copied agent request", exact: true }).waitFor();
    const request = await application.evaluate(({ clipboard }) => clipboard.readText());
    const submitted = await client.plan({ action: "read", name: "marking-plan" });
    if (submitted.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(submitted.snapshot.rounds[0].commentIds).toEqual([saved.snapshot.comments[0].id]);
    expect(request).toContain(submitted.snapshot.rounds[0].id);
    await page.getByRole("button", { name: "Resolve comment", exact: true }).click();
    await pin.waitFor({ state: "hidden" });
    await client.plan({
      action: "resolve",
      name: "marking-plan",
      requestId: crypto.randomUUID(),
      commentId: saved.snapshot.comments[0].id,
      resolved: false,
    });
    await pin.waitFor();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await client.publish(
      saved.snapshot.artifact.id,
      {
        name: "marking-plan",
        title: "Marking plan",
        kind: "plan",
        mediaType: "text/html",
        fileName: "plan.html",
        expectedRevision: 1,
      },
      new TextEncoder().encode(html.replace("Introduction", "Updated introduction")),
    );
    await expect
      .poll(() => page.getByLabel("Version", { exact: true }).locator("option").count())
      .toBe(2);
    await page.getByLabel("Version", { exact: true }).selectOption("2");
    await frame.getByText("Updated introduction", { exact: true }).waitFor();
    await pin.waitFor({ state: "hidden" });
    await page.getByLabel("Version", { exact: true }).selectOption("1");
    await frame.getByText("Introduction", { exact: true }).waitFor();
    await pin.waitFor();
    await page.getByRole("button", { name: "Hide feedback" }).click();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(560, 620),
    );
    await pin.waitFor({ state: "hidden" });
    // Captured feedback remains available when responsive reflow hides its live pin.
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByRole("button", { name: "Captured comment 1", exact: true }).click();
    await page
      .getByRole("region", { name: "Pinned comment: Clarify this section.", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Hide feedback" }).click();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Comment", exact: true }).focus();
    await page.keyboard.press("Enter");
    const narrowScreenshot = page.getByRole("img", {
      name: "Frozen plan screenshot, draw annotations here",
    });
    await narrowScreenshot.waitFor();
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).count()).toBe(0);
    await page.screenshot({ path: join(evidence, "pin-placement-narrow-dark.png") });
    const narrowCapture = (await narrowScreenshot.boundingBox())!;
    await page.mouse.click(narrowCapture.x + 120, narrowCapture.y + 150);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("A narrow-window comment.");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Keep its controls small.");
    expect(
      await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue(),
    ).toContain("\n");
    await page.screenshot({ path: join(evidence, "pin-editor-narrow-dark.png") });
    const narrowEditor = (await page.locator(".plan-capture .plan-pin-popover").boundingBox())!;
    expect(narrowEditor.x).toBeGreaterThanOrEqual(0);
    expect(narrowEditor.x + narrowEditor.width).toBeLessThanOrEqual(560);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Send feedback (1)", exact: true }).waitFor();
    await page.mouse.move(550, 600);
    await expectPinTracksScroll(
      page.getByRole("button", {
        name: "Comment: A narrow-window comment.\nKeep its controls small.",
        exact: true,
      }),
    );
    const final = await client.plan({ action: "read", name: "marking-plan" });
    if (final.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(final.snapshot.comments).toHaveLength(2);
    expect(final.snapshot.rounds).toHaveLength(1);
    await page.getByRole("button", { name: "Copy agent request", exact: true }).click();
    await page.getByRole("button", { name: "Copied agent request", exact: true }).waitFor();
    const allRounds = await client.plan({ action: "read", name: "marking-plan" });
    if (allRounds.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(allRounds.snapshot.rounds).toHaveLength(2);
    const combinedRequest = await application.evaluate(({ clipboard }) => clipboard.readText());
    for (const round of allRounds.snapshot.rounds) expect(combinedRequest).toContain(round.id);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
