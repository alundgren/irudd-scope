import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

const html = `<!doctype html><button onclick="scope.windows.open({title:'Review window',html:'<h1>Review content</h1><input aria-label=&quot;Window draft&quot;>'})">Open review</button>`;

test("content windows move from their title and frame while preserving controls and drafts", async () => {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-movement-gh-"));
  await writeFile(join(ghDirectory, "gh"), '#!/bin/sh\necho "Synthetic offline" >&2\nexit 1\n', {
    mode: 0o700,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${ghDirectory}:${previousPath}`;
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  try {
    fixture = await desktopFixture();
  } finally {
    process.env.PATH = previousPath;
  }
  const app = await fixture.launch();
  try {
    const page = await app.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.evaluate(
      (html) =>
        window.scope.createPullRequests({
          name: "moving-windows",
          title: "Moving windows",
          html,
          repository: { owner: "synthetic", name: "project" },
        }),
      html,
    );
    await page
      .frameLocator(".pull-requests-document")
      .getByRole("button", { name: "Open review" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Review window" });
    const frame = dialog.locator("..");
    const content = dialog.frameLocator("iframe");
    const title = dialog.getByRole("heading", { name: "Review window" });
    await content.getByLabel("Window draft").fill("Keep while moving");
    const original = (await frame.boundingBox())!;
    expect(await dialog.getByRole("button", { name: "Move content window" }).count()).toBe(0);
    for (const edge of ["title", "left", "right", "bottom"] as const) {
      const before = (await frame.boundingBox())!;
      const titleBounds = (await title.boundingBox())!;
      const x =
        edge === "title"
          ? titleBounds.x + 20
          : before.x + (edge === "left" ? 2 : edge === "right" ? before.width - 2 : 80);
      const y =
        edge === "title"
          ? titleBounds.y + 10
          : before.y + (edge === "bottom" ? before.height - 2 : before.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 10, y - 10, { steps: 4 });
      await page.mouse.up();
      expect((await frame.boundingBox())!.x).toBeCloseTo(before.x - 10, 1);
      expect((await frame.boundingBox())!.y).toBeCloseTo(before.y - 10, 1);
      await page.keyboard.press("Home");
    }
    const titleBounds = (await title.boundingBox())!;
    await page.mouse.move(titleBounds.x + 20, titleBounds.y + 10);
    await page.mouse.down();
    await page.mouse.move(titleBounds.x, titleBounds.y, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await frame.boundingBox()).toEqual(original);
    expect(await content.getByLabel("Window draft").inputValue()).toBe("Keep while moving");
    await title.dblclick();
    await dialog.getByRole("button", { name: "Restore content window" }).click();
    expect(await frame.boundingBox()).toEqual(original);
    const resize = (await dialog
      .getByRole("button", { name: "Resize content window" })
      .boundingBox())!;
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
    await page.mouse.down();
    await page.mouse.move(resize.x + resize.width / 2 - 80, resize.y + resize.height / 2 - 60, {
      steps: 4,
    });
    await page.mouse.up();
    const resized = (await frame.boundingBox())!;
    expect(resized.x).toBeCloseTo(original.x, 1);
    expect(resized.y).toBeCloseTo(original.y, 1);
    expect(resized.width).toBeCloseTo(original.width - 80, 1);
    expect(resized.height).toBeCloseTo(original.height - 60, 1);
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "movable-pr-window.png"),
      });
    }
    await dialog.getByRole("button", { name: "Close content window" }).click();
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(ghDirectory, { recursive: true, force: true });
  }
});
