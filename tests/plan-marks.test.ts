import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

const html = `<!doctype html><html><head><title>Marking plan</title><style>body{margin:0;background:#f3f8f1;color:#182a21;font:18px system-ui}section{height:400px;padding:24px}button{font:inherit}</style></head><body><section>Introduction</section><section><button onclick="this.textContent='Clicked'">Interactive target</button></section><section>More content</section><section>End</section></body></html>`;
const evidence = "/tmp/scope-plan-ui-evidence";

test("pending boxes stay on the page through scrolling and restart while feedback leaves room for more comments", async () => {
  const { directory, launch, connect } = await desktopFixture();
  let application = await launch();
  try {
    await mkdir(evidence, { recursive: true });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 760),
    );
    let page = await application.firstWindow();
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
    expect(
      await page.getByRole("button", { name: "Box", exact: true }).getAttribute("aria-pressed"),
    ).toBe("true");
    const points = await screenshot.evaluate((element) => {
      const svg = element as SVGSVGElement;
      const matrix = svg.getScreenCTM()!;
      return [
        [0.02, 0.16],
        [0.35, 0.28],
      ].map(([x, y]) => {
        const point = new DOMPoint(
          x * svg.viewBox.baseVal.width,
          y * svg.viewBox.baseVal.height,
        ).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      });
    });
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 5 });
    await page.mouse.up();
    await page.getByLabel("Comment", { exact: true }).fill("Clarify this section.");
    await page.getByRole("button", { name: "Back to plan", exact: true }).click();
    let boxes = page.getByRole("img", { name: "Pending comment marks" }).locator("rect");
    await expect.poll(() => boxes.count()).toBe(1);
    await page.getByRole("button", { name: "Resume comment", exact: true }).click();
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (1)", exact: true }).waitFor();
    await expect.poll(() => boxes.count()).toBe(1);
    await page.screenshot({ path: join(evidence, "pending-box-feedback-light.png") });
    const commentButton = page.getByRole("button", { name: "Comment", exact: true });
    const buttonBounds = (await commentButton.boundingBox())!;
    const panelBounds = (await page
      .getByRole("complementary", { name: "Plan feedback" })
      .boundingBox())!;
    expect(buttonBounds.y).toBeGreaterThanOrEqual(panelBounds.y + panelBounds.height);
    // Clicking here exercises the reported overlap, including pointer hit testing.
    await commentButton.click();
    await page.getByLabel("Comment", { exact: true }).fill("A second comment with the list open.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (2)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Hide feedback" }).click();
    const before = (await boxes.first().boundingBox())!;
    await frame
      .locator("body")
      .evaluate((body) => body.ownerDocument.defaultView!.scrollTo(0, 340));
    await expect
      .poll(async () => (await boxes.first().boundingBox())!.y)
      .toBeCloseTo(before.y - 40, 0);
    await frame.getByRole("button", { name: "Interactive target" }).click();
    await frame.getByRole("button", { name: "Clicked", exact: true }).waitFor();
    await application.close();
    application = await launch();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 760),
    );
    page = await application.firstWindow();
    frame = page.frameLocator(".plan-document");
    await frame.getByRole("button", { name: "Interactive target" }).waitFor();
    boxes = page.getByRole("img", { name: "Pending comment marks" }).locator("rect");
    await expect.poll(() => boxes.count()).toBe(1);
    const client = await connect();
    const saved = await client.plan({ action: "read", name: "marking-plan" });
    if (saved.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(saved.snapshot.comments[0].viewport).toMatchObject({
      scrollX: 0,
      scrollY: 300,
      width: 1000,
    });
    expect(saved.snapshot.comments).toHaveLength(2);
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (2)", exact: true }).click();
    await page.getByText("Awaiting agent · 2 comments", { exact: true }).waitFor();
    expect(await boxes.count()).toBe(1);
    await client.plan({
      action: "resolve",
      name: "marking-plan",
      requestId: crypto.randomUUID(),
      commentId: saved.snapshot.comments[0].id,
      resolved: true,
    });
    await expect.poll(() => boxes.count()).toBe(0);
    await client.plan({
      action: "resolve",
      name: "marking-plan",
      requestId: crypto.randomUUID(),
      commentId: saved.snapshot.comments[0].id,
      resolved: false,
    });
    await expect.poll(() => boxes.count()).toBe(1);
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
    await expect.poll(() => boxes.count()).toBe(0);
    await page.getByLabel("Version", { exact: true }).selectOption("1");
    await frame.getByText("Introduction", { exact: true }).waitFor();
    await expect.poll(() => boxes.count()).toBe(1);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(560, 620),
    );
    await expect.poll(() => boxes.count()).toBe(0);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByLabel("Comment", { exact: true }).fill("A narrow-window comment.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (1)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await page.screenshot({ path: join(evidence, "pending-feedback-narrow-dark.png") });
    await page.getByRole("button", { name: "Comment", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Comment", { exact: true }).fill("A fourth comment from the keyboard.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send feedback (2)", exact: true }).waitFor();
    const final = await client.plan({ action: "read", name: "marking-plan" });
    if (final.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(final.snapshot.comments).toHaveLength(4);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
