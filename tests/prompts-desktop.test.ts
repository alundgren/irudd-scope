import { expect, test } from "vite-plus/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { emptyPromptDocument, type PromptCommand } from "@irudd-scope/protocol/prompts";
import { desktopFixture } from "./desktop-fixture.ts";
import { createPromptItem, promptPng } from "./prompts-fixture.ts";

const editor = (page: Page) => page.getByRole("region", { name: "Combined prompt", exact: true });
const value = (page: Page, field = "Subject") =>
  page.getByRole("textbox", { name: field, exact: true }).inputValue();
async function apply(f: Awaited<ReturnType<typeof desktopFixture>>, command: PromptCommand) {
  const file = join(f.directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(command));
  return JSON.parse((await f.cli("prompts", "apply", file)).stdout);
}
async function read(f: Awaited<ReturnType<typeof desktopFixture>>) {
  return JSON.parse((await f.cli("prompts", "read")).stdout);
}
async function ready(page: Page) {
  await page.getByRole("tab", { name: "Prompts", selected: true, exact: true }).waitFor();
  await expect
    .poll(() => page.getByRole("textbox", { name: "Subject", exact: true }).isEnabled())
    .toBe(true);
}
test(
  "Prompts starts empty, picks CLI images and text, preserves copies, resets with undo, exports a native ZIP and reopens hidden work",
  { tags: ["prompts-keep-originals"] },
  async () => {
    const f = await desktopFixture();
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await ready(page);
      expect(await value(page)).toBe("");
      expect((await read(f)).rendered).toBe("");
      await expect(
        page.evaluate(() =>
          window.scope.savePromptDraft(crypto.randomUUID(), {
            revision: 0,
            document: {
              type: "text-to-image",
              structureId: "text-to-image-seven",
              structureVersion: 1,
              parts: Object.fromEntries(
                [
                  "subject",
                  "action",
                  "environment",
                  "lighting",
                  "style",
                  "composition",
                  "camera",
                ].map((field) => [field, { itemId: null, text: "unowned" }]),
              ) as ReturnType<typeof emptyPromptDocument>["parts"],
            },
          }),
        ),
      ).rejects.toThrow("no longer exists");
      const originalTab = await page
        .getByRole("tab", { name: "Prompts", exact: true })
        .getAttribute("id");
      await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
      await page.getByText("This field's library is empty.", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      const create = createPromptItem();
      await apply(f, create);
      const imageRequest = {
        action: "set-image",
        id: create.id,
        expectedRevision: 1,
        requestId: randomUUID(),
      };
      const requestFile = join(f.directory, "image-request.json");
      const imageFile = join(f.directory, "example.png");
      await writeFile(requestFile, JSON.stringify(imageRequest));
      await writeFile(imageFile, Buffer.from(promptPng, "base64"));
      await f.cli("prompts", "image", requestFile, imageFile);
      await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
      await expect
        .poll(() =>
          page
            .getByRole("img", { name: "Example scene" })
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBe(1);
      await page.getByRole("button", { name: `Use ${create.item.name}`, exact: true }).click();
      await expect.poll(() => value(page)).toBe(create.item.fragment);
      await page
        .getByRole("textbox", { name: "Subject", exact: true })
        .fill("a hand-edited synthetic subject");
      await page.getByText("· Edited", { exact: true }).waitFor();
      await expect
        .poll(async () => (await read(f)).rendered)
        .toBe("A hand-edited synthetic subject.");
      await page.getByRole("textbox", { name: "Subject", exact: true }).focus();
      expect(
        await editor(page).locator('[data-field="subject"]').getAttribute("data-highlighted"),
      ).toBe("true");
      await apply(f, {
        action: "update-item",
        id: create.id,
        requestId: randomUUID(),
        expectedRevision: 2,
        item: { ...create.item, fragment: "the revised library fragment" },
      });
      expect(await value(page)).toBe("a hand-edited synthetic subject");
      await page.getByRole("button", { name: "Restore Subject", exact: true }).click();
      await expect.poll(() => value(page)).toBe("the revised library fragment");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(() => value(page)).toBe("a hand-edited synthetic subject");
      await page.getByRole("button", { name: "Clear Subject", exact: true }).click();
      expect(await value(page)).toBe("");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(() => value(page)).toBe("a hand-edited synthetic subject");
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect.poll(async () => (await read(f)).rendered).toBe("");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect
        .poll(async () => (await read(f)).rendered)
        .toBe("A hand-edited synthetic subject.");
      const divider = page.getByRole("separator", { name: "Editor and combined prompt divider" });
      const dividerBounds = (await divider.boundingBox())!;
      await page.mouse.move(
        dividerBounds.x + dividerBounds.width / 2,
        dividerBounds.y + dividerBounds.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(dividerBounds.x + dividerBounds.width / 2, dividerBounds.y - 30, {
        steps: 5,
      });
      await page.mouse.up();
      expect(await divider.getAttribute("aria-valuenow")).not.toBe("67");
      await divider.focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowUp");
      expect(await divider.getAttribute("aria-valuenow")).toBe("65");
      await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
      expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        "A hand-edited synthetic subject.",
      );
      const zip = join(f.directory, "library.zip");
      await application.evaluate(({ dialog }, zip) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: zip });
      }, zip);
      await page.getByRole("button", { name: "Prompt actions", exact: true }).click();
      await page.getByRole("button", { name: "Export library ZIP", exact: true }).click();
      await page.getByText("Prompt library exported.", { exact: true }).waitFor();
      const archive = unzipSync(await readFile(zip));
      expect(Object.keys(archive)).toEqual(
        expect.arrayContaining(["manifest.json", "library.json"]),
      );
      expect(Object.keys(archive).some((file) => file.startsWith("images/"))).toBe(true);
      expect(
        JSON.stringify(Object.values(archive).map((bytes) => Buffer.from(bytes).toString())),
      ).not.toContain("hand-edited synthetic subject");
      await apply(f, {
        action: "delete-item",
        id: create.id,
        requestId: randomUUID(),
        expectedRevision: 3,
      });
      await expect
        .poll(async () => (await read(f)).workspace.document.parts.subject.itemId)
        .toBe(null);
      expect(await value(page)).toBe("a hand-edited synthetic subject");
      await page.getByRole("tab", { name: "Prompts", exact: true }).focus();
      await page.keyboard.press("Delete");
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      await apply(f, createPromptItem("camera"));
      expect(await page.getByRole("tab", { name: "Prompts", exact: true }).count()).toBe(0);
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByLabel("Search artifacts", { exact: true }).fill("prompts");
      await page.getByRole("button", { name: "Prompts", exact: true }).click();
      await ready(page);
      expect(await page.getByRole("tab", { name: "Prompts", exact: true }).getAttribute("id")).toBe(
        originalTab,
      );
      expect(await value(page)).toBe("a hand-edited synthetic subject");
      expect(await page.getByRole("separator").getAttribute("aria-valuenow")).toBe("65");
      expect(
        (await page.evaluate(() => window.scope.workspace()))?.tabs.filter(
          (tab) => tab.type === "prompts",
        ),
      ).toHaveLength(1);
      expect(failures).toEqual([]);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
