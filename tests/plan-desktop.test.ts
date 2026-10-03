import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { PlanSnapshot } from "@irudd-scope/protocol/plan";
import { desktopFixture } from "./desktop-fixture.ts";

const html = `<!doctype html><html><head><title>Checkout page</title><style>body{margin:0;padding:40px;font:18px system-ui;background:#f3f8f1;color:#182a21}button{font:inherit;padding:12px}section{height:1600px}input{font:inherit}</style></head><body><h1>Interactive checkout</h1><button id="next" onclick="document.querySelector('h1').textContent='Payment details';this.hidden=true">Next step</button><input aria-label="Order reference"><section>Keep this authored page interactive.</section></body></html>`;
const evidence = "/tmp/scope-plan-ui-evidence";
async function draw(page: Page, from: [number, number], to: [number, number]) {
  const screenshot = page.getByRole("img", {
    name: "Frozen plan screenshot, draw annotations here",
  });
  await Promise.race([
    screenshot.waitFor(),
    page
      .getByRole("alert")
      .first()
      .waitFor()
      .then(async () => {
        throw new Error(
          `Plan capture failed: ${(await page.getByRole("alert").allTextContents()).join(" ")}`,
        );
      }),
  ]);
  const points = await screenshot.evaluate(
    (element, values) => {
      const svg = element as SVGSVGElement;
      const rect = svg.viewBox.baseVal;
      const matrix = svg.getScreenCTM()!;
      return values.map(([x, y]) => {
        const point = new DOMPoint(x * rect.width, y * rect.height).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      });
    },
    [from, to],
  );
  await page.mouse.click(points[1].x, points[1].y);
}

test("a plan keeps interactive HTML while captured comments, feedback, replies, and versions persist", async () => {
  const { directory, launch, connect } = await desktopFixture({
    showWindow: process.platform === "darwin",
  });
  let application = await launch();
  try {
    await mkdir(evidence, { recursive: true });
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Create plan", exact: true }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Checkout plan with a deliberately long readable title");
    const file = join(directory, "checkout.html");
    await writeFile(file, html);
    await page.getByLabel("HTML file, optional").setInputFiles(file);
    await page.getByRole("button", { name: "Create plan", exact: true }).click();
    let frame = page.frameLocator(".plan-document");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    expect(await page.getByRole("complementary", { name: "Plan feedback" }).count()).toBe(0);
    await frame.getByRole("button", { name: "Next step" }).click();
    await frame.getByRole("textbox", { name: "Order reference" }).fill("order-123");
    await page.screenshot({ path: join(evidence, "reading-light.png") });
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByRole("complementary", { name: "Plan feedback" }).waitFor();
    await page.getByRole("button", { name: "Hide feedback" }).click();
    expect(await frame.getByRole("heading", { name: "Payment details" }).textContent()).toBe(
      "Payment details",
    );
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "order-123",
    );
    const workspace = await page.evaluate(() => window.scope.workspace());
    const tab = workspace!.tabs.find((entry) => entry.type === "plan")!;
    const client = await connect();
    const artifacts = await client.list();
    const artifact = artifacts.find((entry) => entry.id === tab.state.data.artifactId)!;
    expect(artifact.name).toMatch(/^plan-/);
    expect(
      (await page.evaluate(() => window.scope.retainedTabs())).find(
        (entry) => entry.tab.id === tab.id,
      )?.permanent,
    ).toBe(true);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("dialog", { name: "Comment on captured page" }).waitFor();
    expect(await page.getByRole("button", { name: "Box", exact: true }).count()).toBe(0);
    expect(await page.getByLabel("Page label, optional").count()).toBe(0);
    const captureBounds = (await page
      .getByRole("img", { name: "Frozen plan screenshot, draw annotations here" })
      .boundingBox())!;
    const pageBounds = (await page.locator(".plan-document").boundingBox())!;
    expect(captureBounds.height).toBeCloseTo(pageBounds.height, 0);
    expect(await page.getByRole("button", { name: "Arrow", exact: true }).count()).toBe(0);
    await draw(page, [0.12, 0.12], [0.35, 0.22]);
    await draw(page, [0.2, 0.3], [0.55, 0.5]);
    await draw(page, [0.4, 0.4], [0.4, 0.4]);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Make the payment step easier to find.");
    await page.screenshot({ path: join(evidence, "captured-marks.png") });
    await page.getByRole("button", { name: "Back to plan", exact: true }).click();
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "order-123",
    );
    await page.getByRole("button", { name: "Resume comment" }).click();
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Make the payment step easier to find.",
    );
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    frame = page.frameLocator(".plan-document");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await page.getByRole("button", { name: "Resume comment" }).click();
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Make the payment step easier to find.",
    );
    const retained = await page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id);
    expect(retained?.annotations.map((mark) => mark.type)).toEqual(["pin"]);
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (1)" }).waitFor();
    const restartedClient = await connect();
    async function snapshot(): Promise<PlanSnapshot> {
      const reply = await restartedClient.plan({ action: "read", name: artifact.name! });
      if (reply.type !== "snapshot") throw new Error("Expected plan snapshot.");
      return reply.snapshot;
    }
    const queued = await snapshot();
    expect(queued.comments).toHaveLength(1);
    const comment = queued.comments[0];
    expect(comment.revision).toBe(1);
    const marked = await restartedClient.planImage(artifact.name!, comment.image.id);
    const original = await restartedClient.planImage(artifact.name!, comment.originalImage.id);
    expect(Buffer.from(marked).equals(Buffer.from(original))).toBe(false);
    await writeFile(join(evidence, "agent-annotated.png"), marked);
    await writeFile(join(evidence, "original-capture.png"), original);
    const redPixels = await application.evaluate(
      ({ nativeImage }, bytes) => {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes));
        const bitmap = image.toBitmap();
        let count = 0;
        for (let offset = 0; offset < bitmap.length; offset += 4)
          if (bitmap[offset + 2] > 140 && bitmap[offset + 1] < 80 && bitmap[offset] < 100) count++;
        return count;
      },
      [...marked],
    );
    expect(redPixels).toBeGreaterThan(100);
    await page.getByRole("button", { name: "Send feedback (1)" }).click();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByText("Awaiting agent · 1 comment").waitFor();
    const submitted = await snapshot();
    await page.getByRole("button", { name: "Copy agent request", exact: true }).click();
    await page.getByRole("button", { name: "Copied agent request", exact: true }).waitFor();
    const agentRequest = await application.evaluate(({ clipboard }) => clipboard.readText());
    expect(agentRequest).toContain(
      `irudd-scope plan feedback ${artifact.name} ${submitted.rounds[0].id} --output NEW_DIRECTORY`,
    );
    expect(agentRequest).toContain("packet.json");
    expect(agentRequest).toContain("annotated PNGs");
    expect(agentRequest).toContain("irudd-scope plan respond");
    const response = await restartedClient.plan({
      action: "respond",
      name: artifact.name!,
      requestId: crypto.randomUUID(),
      roundId: submitted.rounds[0].id,
      expectedRevision: 1,
      summary: "The payment heading is clearer.",
      replies: [{ commentId: comment.id, text: "Added a visible payment heading." }],
      html: html.replace("Interactive checkout", "Revised checkout"),
    });
    expect(response.type).toBe("receipt");
    await page.getByText("The payment heading is clearer.", { exact: true }).waitFor();
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await page.getByRole("button", { name: "Mark seen", exact: true }).click();
    await expect.poll(async () => (await snapshot()).responses[0].seen).toBe(true);
    expect((await snapshot()).comments[0].resolved).toBe(false);
    await page.getByRole("button", { name: "View version 2", exact: true }).click();
    await frame.getByRole("heading", { name: "Revised checkout" }).waitFor();
    await page.getByRole("button", { name: "Captured comment 1", exact: true }).click();
    await page.getByRole("button", { name: "Resolve comment", exact: true }).click();
    await expect.poll(async () => (await snapshot()).comments[0].resolved).toBe(true);
    await page.getByRole("button", { name: "Approve version", exact: true }).click();
    await expect.poll(async () => (await snapshot()).revisions[1].approvedAt).not.toBeNull();
    await page.getByLabel("Version", { exact: true }).selectOption("1");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await page.getByRole("button", { name: "Restore this version", exact: true }).click();
    await expect.poll(async () => (await snapshot()).artifact.revision).toBe(3);
    await page.screenshot({ path: join(evidence, "review-light.png") });
    await page.getByRole("button", { name: "Hide feedback" }).click();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await page.getByRole("combobox", { name: "Fullscreen HTML mode" }).waitFor();
    expect(await page.getByRole("complementary", { name: "Plan feedback" }).count()).toBe(0);
    await page.screenshot({ path: join(evidence, "focus.png") });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isFullScreen(),
        ),
      )
      .toBe(true);
    await page.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isFullScreen(),
        ),
      )
      .toBe(false);
    await page.setViewportSize({ width: 560, height: 620 });
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.screenshot({ path: join(evidence, "review-narrow-dark.png") });
    const iframeWidth = await page
      .locator(".plan-document")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(iframeWidth).toBe(await page.evaluate(() => window.innerWidth));
    expect(iframeWidth).toBeLessThanOrEqual(700);
    await page.getByRole("button", { name: "Hide feedback" }).click();
    await page.screenshot({ path: join(evidence, "reading-narrow-dark.png") });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("plan navigation preserves authored state, historical capture, and unsent work while ordinary publication updates history", async () => {
  const { directory, launch, connect } = await desktopFixture({
    showWindow: process.platform === "darwin",
  });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const artifact = await page.evaluate(
      (content) =>
        window.scope.createPlan({
          name: "navigation-plan",
          title: "Navigation plan",
          html: content,
        }),
      html,
    );
    const frame = page.frameLocator(".plan-document");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await frame.getByRole("button", { name: "Next step" }).click();
    await frame.getByRole("textbox", { name: "Order reference" }).fill("keep-input");
    await frame
      .locator("body")
      .evaluate((body) => body.ownerDocument.defaultView!.scrollTo(0, 280));
    const client = await connect();
    await client.publish(
      artifact.id,
      {
        name: artifact.name,
        title: artifact.title,
        kind: "plan",
        mediaType: "text/html",
        fileName: "next.html",
        expectedRevision: 1,
      },
      new TextEncoder().encode(html.replace("Interactive checkout", "Published next checkout")),
    );
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await expect
      .poll(() => page.getByLabel("Version", { exact: true }).locator("option").count())
      .toBe(2);
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "keep-input",
    );
    expect(
      await frame.locator("body").evaluate((body) => body.ownerDocument.defaultView!.scrollY),
    ).toBe(280);
    await page.getByRole("button", { name: "Hide feedback" }).click();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("dialog", { name: "Comment on captured page" }).waitFor();
    await draw(page, [0.25, 0.25], [0.25, 0.25]);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Unsent historical comment");
    await client.publish(
      crypto.randomUUID(),
      {
        title: "Other artifact",
        kind: "text",
        mediaType: "text/plain",
        fileName: "other.txt",
        expectedRevision: 0,
      },
      new TextEncoder().encode("A separate tab."),
    );
    await page.getByRole("tab", { name: "Other artifact", exact: true }).click();
    await page.getByText("A separate tab.", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Navigation plan", exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(async (artifactId) => {
            const workspace = await window.scope.workspace();
            const planTab = workspace?.tabs.find((tab) => tab.state.data.artifactId === artifactId);
            return Boolean(workspace && planTab && workspace.selected === planTab.id);
          }, artifact.id),
        { timeout: 5_000 },
      )
      .toBe(true);
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Unsent historical comment",
    );
    await page.getByRole("button", { name: "Discard comment", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Comment on captured page" })
      .waitFor({ state: "hidden" });
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "keep-input",
    );
    expect(
      await frame.locator("body").evaluate((body) => body.ownerDocument.defaultView!.scrollY),
    ).toBe(280);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await draw(page, [0.25, 0.25], [0.25, 0.25]);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Fresh comment on the original page");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (1)" }).waitFor();
    const reply = await client.plan({ action: "read", name: artifact.name! });
    if (reply.type !== "snapshot") throw new Error("Expected plan snapshot.");
    expect(reply.snapshot.comments[0].revision).toBe(1);
    expect(reply.snapshot.comments[0].text).toBe("Fresh comment on the original page");
    expect(await page.getByRole("complementary", { name: "Plan feedback" }).count()).toBe(0);
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "keep-input",
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("zoomed plan capture includes the full authored viewport with normalized marks", async () => {
  const { directory, launch } = await desktopFixture({ showWindow: process.platform === "darwin" });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.evaluate(
      (content) =>
        window.scope.createPlan({ name: "zoomed-plan", title: "Zoomed plan", html: content }),
      html.replace(
        "</body>",
        '<div style="position:fixed;right:20px;bottom:20px;width:60px;height:60px;background:#2060b0" aria-label="Bottom right marker"></div></body>',
      ),
    );
    const frame = page.frameLocator(".plan-document");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await frame.getByRole("button", { name: "Next step" }).click();
    await frame.getByRole("textbox", { name: "Order reference" }).fill("zoom-preserved");
    const native = await application.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(1281, 821);
      window.webContents.setZoomFactor(1.25);
      return {
        scale: screen.getDisplayMatching(window.getBounds()).scaleFactor,
        zoom: window.webContents.getZoomFactor(),
      };
    });
    await expect
      .poll(() => page.evaluate(() => window.devicePixelRatio))
      .toBeCloseTo(native.zoom * native.scale, 2);
    const rect = await page.locator(".plan-document").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, dpr: window.devicePixelRatio };
    });
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("dialog", { name: "Comment on captured page" }).waitFor();
    const workspace = await page.evaluate(() => window.scope.workspace());
    const tab = workspace!.tabs.find((entry) => entry.type === "plan")!;
    await expect
      .poll(() => page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id))
      .not.toBeNull();
    const draft = await page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id);
    expect(Math.abs(draft!.width - rect.width * rect.dpr)).toBeLessThanOrEqual(3);
    expect(Math.abs(draft!.height - rect.height * rect.dpr)).toBeLessThanOrEqual(3);
    const marker = await application.evaluate(({ nativeImage }, image) => {
      const capture = nativeImage.createFromBuffer(Buffer.from(image, "base64"));
      const size = capture.getSize();
      const bitmap = capture.toBitmap();
      const offset =
        (Math.floor(size.height * 0.94) * size.width + Math.floor(size.width * 0.95)) * 4;
      return [...bitmap.subarray(offset, offset + 3)];
    }, draft!.image);
    expect(marker).toEqual([176, 96, 32]);
    await draw(page, [0.9, 0.86], [0.99, 0.99]);
    await expect
      .poll(async () => {
        const mark = (await page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id))
          ?.annotations[0];
        return mark?.type === "pin" ? mark.at.x : undefined;
      })
      .toBeCloseTo(0.99, 2);
    const annotation = (await page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id))!
      .annotations[0];
    if (annotation.type !== "pin") throw new Error("Expected pin annotation.");
    expect(annotation.at.x).toBeCloseTo(0.99, 2);
    expect(annotation.at.y).toBeCloseTo(0.99, 2);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("The marker remains visible at zoom.");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "capture-zoomed.png") });
    await page.getByRole("button", { name: "Discard comment", exact: true }).click();
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "zoom-preserved",
    );
  } finally {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
    );
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("deleting queued comments from their pin and Feedback sends only the remaining comments", async () => {
  const { directory, launch, connect } = await desktopFixture({
    showWindow: process.platform === "darwin",
  });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.evaluate(
      (content) =>
        window.scope.createPlan({ name: "queue-plan", title: "Queue plan", html: content }),
      html,
    );
    await page
      .frameLocator(".plan-document")
      .getByRole("heading", { name: "Interactive checkout" })
      .waitFor();
    for (const [index, text] of [
      "First queued comment",
      "Second queued comment",
      "Third queued comment",
    ].entries()) {
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await draw(page, [0.15 + index * 0.25, 0.2], [0.15 + index * 0.25, 0.2]);
      await page.getByRole("textbox", { name: "Comment", exact: true }).fill(text);
      await page.getByRole("button", { name: "Add comment", exact: true }).click();
      await page
        .getByRole("button", { name: `Send feedback (${index + 1})`, exact: true })
        .waitFor();
    }
    await page.getByRole("button", { name: "Comment: First queued comment", exact: true }).click();
    expect(await page.getByRole("button", { name: "Resolve comment", exact: true }).count()).toBe(
      0,
    );
    await page.getByRole("button", { name: "Delete comment", exact: true }).click();
    await page
      .getByRole("button", { name: "Comment: First queued comment", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Send feedback (2)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByRole("button", { name: "Captured comment 1", exact: true }).click();
    const queued = page.getByRole("region", {
      name: "Pinned comment: Second queued comment",
      exact: true,
    });
    await queued.waitFor();
    expect(await queued.getByRole("button", { name: "Resolve comment", exact: true }).count()).toBe(
      0,
    );
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "queued-delete-feedback.png") });
    await queued.getByRole("button", { name: "Delete comment", exact: true }).click();
    await queued.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Hide feedback" }).click();
    await page.getByRole("button", { name: "Send feedback (1)", exact: true }).click();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByText("Awaiting agent · 1 comment", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Captured comment 1", exact: true }).click();
    await page.getByRole("button", { name: "Resolve comment", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Delete comment", exact: true }).count()).toBe(0);
    const client = await connect();
    const result = await client.plan({ action: "read", name: "queue-plan" });
    if (result.type !== "snapshot") throw new Error("Expected plan snapshot.");
    const remaining = result.snapshot.comments;
    expect(result.snapshot.rounds[0].commentIds).toEqual(remaining.map((comment) => comment.id));
    expect(remaining.map((comment) => comment.text)).toEqual(["Third queued comment"]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("Escape closes plan capture before workspace shortcuts and focus keeps an unsent capture", async () => {
  const { directory, launch } = await desktopFixture({ showWindow: process.platform === "darwin" });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.evaluate(
      (content) =>
        window.scope.createPlan({
          name: "focus-capture-plan",
          title: "Focus capture plan",
          html: content,
        }),
      html,
    );
    const frame = page.frameLocator(".plan-document");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await frame.getByRole("textbox", { name: "Order reference" }).fill("kept in focus");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await draw(page, [0.35, 0.25], [0.35, 0.25]);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Keep this draft while reading.");
    await page.getByRole("textbox", { name: "Comment", exact: true }).focus();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Resume comment", exact: true }).waitFor();
    expect(await page.getByRole("dialog", { name: "Comment on captured page" }).count()).toBe(0);
    await page.getByRole("button", { name: "Resume comment", exact: true }).click();
    await page.getByRole("textbox", { name: "Comment", exact: true }).focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+F" : "Control+Shift+F");
    await page.getByRole("combobox", { name: "Fullscreen HTML mode" }).waitFor();
    expect(await page.getByRole("dialog", { name: "Comment on captured page" }).count()).toBe(0);
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "kept in focus",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Comment on captured page" }).waitFor();
    expect(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Keep this draft while reading.",
    );
    await page.getByRole("textbox", { name: "Comment", exact: true }).focus();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Resume comment", exact: true }).waitFor();
    const workspace = await page.evaluate(() => window.scope.workspace());
    const tab = workspace!.tabs.find((entry) => entry.type === "plan")!;
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.scope.loadPlanDraft(id), tab.id))?.annotations.length,
      )
      .toBe(1);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("plan metadata refreshes after reconnect when a text-only response notification was missed", async () => {
  const { directory, launch, connect } = await desktopFixture({
    showWindow: process.platform === "darwin",
  });
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.evaluate(
      (content) =>
        window.scope.createPlan({ name: "reconnect-plan", title: "Reconnect plan", html: content }),
      html,
    );
    const frame = page.frameLocator(".plan-document");
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    await frame.getByRole("textbox", { name: "Order reference" }).fill("keep during reconnect");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await draw(page, [0.25, 0.25], [0.25, 0.25]);
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Explain the payment step.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (1)", exact: true }).click();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByText("Awaiting agent · 1 comment", { exact: true }).waitFor();
    const client = await connect();
    const before = await client.plan({ action: "read", name: "reconnect-plan" });
    if (before.type !== "snapshot") throw new Error("Expected plan snapshot.");
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const send = contents.send.bind(contents);
      const signals = { dropped: 0, reconnected: 0 };
      (globalThis as typeof globalThis & { planTestSignals?: typeof signals }).planTestSignals =
        signals;
      contents.send = (channel: string, ...args: unknown[]) => {
        if (
          channel === "scope:plan-changed" &&
          (args[0] as { event?: string })?.event === "response" &&
          !signals.dropped
        ) {
          signals.dropped++;
          return;
        }
        if (channel === "scope:plan-reconnected") signals.reconnected++;
        send(channel, ...args);
      };
    });
    const response = await client.plan({
      action: "respond",
      name: "reconnect-plan",
      requestId: crypto.randomUUID(),
      roundId: before.snapshot.rounds[0].id,
      expectedRevision: 1,
      summary: "Payment explanation recovered after reconnect.",
      replies: [
        {
          commentId: before.snapshot.comments[0].id,
          text: "This is the payment step, with no HTML changes.",
        },
      ],
    });
    expect(response.type).toBe("receipt");
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { planTestSignals?: { dropped: number } })
              .planTestSignals?.dropped,
        ),
      )
      .toBe(1);
    expect(
      await page
        .getByText("Payment explanation recovered after reconnect.", { exact: true })
        .count(),
    ).toBe(0);
    await page.getByText("Awaiting agent · 1 comment", { exact: true }).waitFor();
    const disconnected = await application.evaluate(
      (_electron, port) => {
        const handles = (
          process as unknown as {
            _getActiveHandles: () => Array<{
              localPort?: number;
              remotePort?: number;
              destroy?: () => void;
            }>;
          }
        )._getActiveHandles();
        const sockets = handles.filter(
          (handle) => handle.localPort === port || handle.remotePort === port,
        );
        for (const socket of sockets) socket.destroy?.();
        return sockets.length;
      },
      Number(new URL(client.endpoint).port),
    );
    expect(disconnected).toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { planTestSignals?: { reconnected: number } })
                .planTestSignals?.reconnected,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    await page
      .getByText("Payment explanation recovered after reconnect.", { exact: true })
      .waitFor();
    expect(await page.getByText("Awaiting agent · 1 comment", { exact: true }).count()).toBe(0);
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "keep during reconnect",
    );
    const after = await client.plan({ action: "read", name: "reconnect-plan" });
    if (after.type !== "snapshot") throw new Error("Expected plan snapshot.");
    expect(after.snapshot.artifact.revision).toBe(1);
    expect(after.snapshot.version).toBeGreaterThan(before.snapshot.version);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
