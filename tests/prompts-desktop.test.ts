import { expect, test } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { once } from "node:events";
import { crc32, deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  PROMPT_FIELDS,
  PROMPT_STRUCTURE,
  emptyPromptDocument,
  type PromptCommand,
} from "@irudd-scope/protocol/prompts";
import { desktopFixture } from "./desktop-fixture.ts";
import { createPromptItem, promptPng } from "./prompts-fixture.ts";

function examplePng(color: number) {
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512);
  header.writeUInt32BE(320, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(320 * (512 * 3 + 1));
  for (let y = 0; y < 320; y++)
    for (let x = 0; x < 512; x++) {
      const offset = y * (512 * 3 + 1) + 1 + x * 3;
      pixels[offset] = ((x + color * 70) % 220) + 20;
      pixels[offset + 1] = ((y + color * 40) % 200) + 30;
      pixels[offset + 2] = 110 + color * 35;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
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
async function gateCommand(
  application: ElectronApplication,
  after: boolean,
  fail = false,
  action = "update-workspace",
) {
  await application.evaluate(
    ({ ipcMain }, { after, fail, action }) => {
      type Handler = Parameters<typeof ipcMain.handle>[1];
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get("scope:prompt-command")!;
      const state = globalThis as typeof globalThis & {
        promptGate: { started: boolean; release: () => void };
      };
      let release!: () => void;
      const waiting = new Promise<void>((done) => {
        release = done;
      });
      state.promptGate = { started: false, release };
      ipcMain.removeHandler("scope:prompt-command");
      ipcMain.handle("scope:prompt-command", async (event, input) => {
        if (input.action !== action) return original(event, input);
        ipcMain.removeHandler("scope:prompt-command");
        ipcMain.handle("scope:prompt-command", original);
        const result = after ? await original(event, input) : undefined;
        state.promptGate.started = true;
        await waiting;
        if (fail) throw new Error("Synthetic lost save response");
        return after ? result : original(event, input);
      });
    },
    { after, fail, action },
  );
  return {
    started: () =>
      application.evaluate(
        () =>
          (globalThis as typeof globalThis & { promptGate: { started: boolean } }).promptGate
            .started,
      ),
    release: () =>
      application.evaluate(() =>
        (
          globalThis as typeof globalThis & { promptGate: { release: () => void } }
        ).promptGate.release(),
      ),
  };
}

test("Prompts starts empty, picks CLI images and text, preserves copies, resets with undo, exports a native ZIP and reopens hidden work", async () => {
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
    expect(Object.keys(archive)).toEqual(expect.arrayContaining(["manifest.json", "library.json"]));
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
});

test.for(["desktop typing", "CLI update"] as const)(
  "Undo cannot discard a newer Camera edit from %s after clearing Subject",
  async (source) => {
    const f = await desktopFixture();
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await ready(page);
      const subject = page.getByRole("textbox", { name: "Subject", exact: true });
      const camera = page.getByRole("textbox", { name: "Camera", exact: true });
      await subject.fill("subject to recover");
      await camera.fill("original camera");
      await expect
        .poll(async () => (await read(f)).workspace.document.parts.camera.text)
        .toBe("original camera");
      await page.getByRole("button", { name: "Clear Subject", exact: true }).click();
      await expect.poll(async () => (await read(f)).workspace.document.parts.subject.text).toBe("");
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect.poll(() => undo.isVisible()).toBe(true);
      const newer = `newer camera from ${source}`;
      if (source === "desktop typing") await camera.fill(newer);
      else {
        const current = (await read(f)).workspace;
        current.document.parts.camera.text = newer;
        await apply(f, {
          action: "update-workspace",
          requestId: randomUUID(),
          expectedRevision: current.revision,
          document: current.document,
        });
      }
      await expect.poll(() => camera.inputValue()).toBe(newer);
      await expect
        .poll(async () => (await read(f)).workspace.document.parts.camera.text)
        .toBe(newer);
      if (await undo.isVisible()) await undo.click();
      await expect
        .poll(async () => ({
          displayed: await camera.inputValue(),
          saved: (await read(f)).workspace.document.parts.camera.text,
        }))
        .toEqual({ displayed: newer, saved: newer });
      expect(await undo.isVisible()).toBe(false);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("loading the saved prompt after a conflict retains immediate Undo of local text", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await ready(page);
    const gate = await gateCommand(application, false);
    await page.getByRole("textbox", { name: "Subject", exact: true }).fill("local recovery text");
    await expect.poll(gate.started).toBe(true);
    const current = (await read(f)).workspace;
    current.document.parts.subject.text = "agent saved text";
    await apply(f, {
      action: "update-workspace",
      requestId: randomUUID(),
      expectedRevision: current.revision,
      document: current.document,
    });
    await gate.release();
    await page.getByRole("button", { name: "Use saved prompt", exact: true }).click();
    await expect.poll(() => value(page)).toBe("agent saved text");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => value(page)).toBe("local recovery text");
    await expect
      .poll(async () => (await read(f)).workspace.document.parts.subject.text)
      .toBe("local recovery text");
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("typing during saved-prompt recovery cannot create Undo that discards newer text", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await ready(page);
    const subject = page.getByRole("textbox", { name: "Subject", exact: true });
    const camera = page.getByRole("textbox", { name: "Camera", exact: true });
    await subject.fill("original subject");
    await camera.fill("original camera");
    await expect
      .poll(async () => (await read(f)).workspace.document.parts.camera.text)
      .toBe("original camera");
    const save = await gateCommand(application, false);
    await subject.fill("local recovery text");
    await expect.poll(save.started).toBe(true);
    const current = (await read(f)).workspace;
    current.document.parts.subject.text = "agent saved subject";
    await apply(f, {
      action: "update-workspace",
      requestId: randomUUID(),
      expectedRevision: current.revision,
      document: current.document,
    });
    await save.release();
    await page.getByRole("button", { name: "Use saved prompt", exact: true }).waitFor();
    await application.evaluate(({ ipcMain }) => {
      type Handler = Parameters<typeof ipcMain.handle>[1];
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get("scope:save-prompt-draft")!;
      const state = globalThis as typeof globalThis & {
        promptCleanup: { started: boolean; release: () => void };
      };
      let release!: () => void;
      const waiting = new Promise<void>((done) => {
        release = done;
      });
      state.promptCleanup = { started: false, release };
      ipcMain.removeHandler("scope:save-prompt-draft");
      ipcMain.handle("scope:save-prompt-draft", async (event, input) => {
        if (input.draft !== null) return original(event, input);
        ipcMain.removeHandler("scope:save-prompt-draft");
        ipcMain.handle("scope:save-prompt-draft", original);
        state.promptCleanup.started = true;
        await waiting;
        return original(event, input);
      });
    });
    await page.getByRole("button", { name: "Use saved prompt", exact: true }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { promptCleanup: { started: boolean } })
              .promptCleanup.started,
        ),
      )
      .toBe(true);
    const newer = "new camera typed during recovery";
    await camera.fill(newer);
    await application.evaluate(() =>
      (
        globalThis as typeof globalThis & { promptCleanup: { release: () => void } }
      ).promptCleanup.release(),
    );
    await expect.poll(() => subject.inputValue()).toBe("agent saved subject");
    await expect.poll(async () => (await read(f)).workspace.document.parts.camera.text).toBe(newer);
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    if (await undo.isVisible()) await undo.click();
    await expect
      .poll(async () => ({
        displayed: await camera.inputValue(),
        saved: (await read(f)).workspace.document.parts.camera.text,
      }))
      .toEqual({ displayed: newer, saved: newer });
    expect(await undo.isVisible()).toBe(false);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test.for(["Escape", "Back"] as const)(
  "closing a pending picker with %s preserves later typing and a newly opened picker",
  async (close) => {
    const f = await desktopFixture();
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await ready(page);
      const create = createPromptItem();
      await apply(f, create);
      await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
      const gate = await gateCommand(application, true, false, "read-item");
      await page.getByRole("button", { name: `Use ${create.item.name}`, exact: true }).click();
      await expect.poll(gate.started).toBe(true);
      if (close === "Escape") await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: "Back to prompt", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const text = `newer text after closing with ${close}`;
      await page.getByRole("textbox", { name: "Subject", exact: true }).fill(text);
      await expect
        .poll(async () => (await read(f)).workspace.document.parts.subject.text)
        .toBe(text);
      await page.getByRole("button", { name: "Choose Camera", exact: true }).click();
      await page.getByRole("dialog", { name: "Camera", exact: true }).waitFor();
      await gate.release();
      // Wait through the autosave interval after delivering the obsolete selection response.
      await page.waitForTimeout(600);
      expect({
        displayed: await page.locator(".prompt-field-subject textarea").inputValue(),
        saved: (await read(f)).workspace.document.parts.subject,
        nextPickerOpen: await page.getByRole("dialog", { name: "Camera", exact: true }).isVisible(),
      }).toEqual({ displayed: text, saved: { itemId: null, text }, nextPickerOpen: true });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("picking after a delayed item read and its Undo preserve a concurrent agent update to another field", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await ready(page);
    const create = createPromptItem();
    await apply(f, create);
    await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
    const gate = await gateCommand(application, true, false, "read-item");
    await page.getByRole("button", { name: `Use ${create.item.name}`, exact: true }).click();
    await expect.poll(gate.started).toBe(true);
    const document = {
      ...emptyPromptDocument(),
      parts: {
        ...emptyPromptDocument().parts,
        camera: { itemId: null, text: "concurrent camera text" },
      },
    };
    await apply(f, {
      action: "update-workspace",
      requestId: randomUUID(),
      expectedRevision: 0,
      document,
    });
    await expect
      .poll(() => page.locator(".prompt-field-camera textarea").inputValue())
      .toBe("concurrent camera text");
    await gate.release();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await expect.poll(() => value(page)).toBe(create.item.fragment);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => (await read(f)).workspace.document).toEqual(document);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an accepted uncertain save keeps later typing and its request identity across a process restart", async () => {
  const f = await desktopFixture();
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    await ready(page);
    const tabId = (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
      (tab) => tab.type === "prompts",
    )!.id;
    const gate = await gateCommand(application, true, true);
    await page.getByRole("textbox", { name: "Subject", exact: true }).fill("dispatched text");
    await expect.poll(gate.started).toBe(true);
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill("later local text with cursor");
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(7, 12));
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.scope.loadPromptDraft(id), tabId))?.document.parts
            .subject.text,
      )
      .toBe("later local text with cursor");
    const draft = await page.evaluate((id) => window.scope.loadPromptDraft(id), tabId);
    expect(draft?.pending).toMatchObject({
      document: { parts: { subject: { text: "dispatched text" } } },
    });
    const requestId =
      draft!.pending!.action === "update-workspace" ? draft!.pending!.requestId : "";
    expect(requestId).not.toBe("");
    await gate.release();
    await page
      .getByRole("alert")
      .filter({ hasText: /lost save response|changed elsewhere/ })
      .waitFor();
    expect(await value(page)).toBe("later local text with cursor");
    expect(
      await page
        .getByRole("textbox", { name: "Subject", exact: true })
        .evaluate((node) => [
          (node as HTMLTextAreaElement).selectionStart,
          (node as HTMLTextAreaElement).selectionEnd,
        ]),
    ).toEqual([7, 12]);
    const exited = once(application.process(), "exit");
    application.process().kill("SIGKILL");
    await exited;
    await application.close().catch(() => {});
    application = await f.launch();
    page = await application.firstWindow();
    await ready(page);
    await expect.poll(() => value(page)).toBe("later local text with cursor");
    await expect.poll(async () => (await read(f)).rendered).toBe("Later local text with cursor.");
    expect(await page.evaluate((id) => window.scope.loadPromptDraft(id), tabId)).toBe(null);
    await application.close();
    application = await f.launch();
    page = await application.firstWindow();
    await ready(page);
    expect(await value(page)).toBe("later local text with cursor");
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("dirty CLI conflicts preserve text through Keep open and sanitize deleted selections before recovery and undo", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await ready(page);
    const create = createPromptItem();
    await apply(f, create);
    await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
    await page.getByRole("button", { name: `Use ${create.item.name}`, exact: true }).click();
    await expect
      .poll(async () => (await read(f)).workspace.document.parts.subject.itemId)
      .toBe(create.id);
    const gate = await gateCommand(application, false);
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill("my text survives a concurrent deletion");
    await expect.poll(gate.started).toBe(true);
    await apply(f, {
      action: "delete-item",
      id: create.id,
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    await gate.release();
    await page.getByRole("button", { name: "Keep my edits", exact: true }).waitFor();
    await application.evaluate(({ dialog, BrowserWindow }) => {
      const state = globalThis as typeof globalThis & { keptOpen: boolean };
      state.keptOpen = false;
      dialog.showMessageBox = async () => {
        state.keptOpen = true;
        return { response: 0, checkboxChecked: false };
      };
      BrowserWindow.getAllWindows()[0]!.close();
    });
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as typeof globalThis & { keptOpen: boolean }).keptOpen,
        ),
      )
      .toBe(true);
    expect(await value(page)).toBe("my text survives a concurrent deletion");
    await page.getByRole("button", { name: "Keep my edits", exact: true }).click();
    await expect
      .poll(async () => (await read(f)).workspace.document.parts.subject)
      .toEqual({ itemId: null, text: "my text survives a concurrent deletion" });
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(async () => (await read(f)).workspace.document.parts.subject)
      .toEqual({ itemId: null, text: "my text survives a concurrent deletion" });
    // Suppress invalidations to exercise the same reread used after event-stream reconnection.
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const original = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel !== "scope:prompts-changed") original(channel, ...args);
      };
    });
    const remote = await read(f);
    await apply(f, {
      action: "update-workspace",
      expectedRevision: remote.workspace.revision,
      requestId: randomUUID(),
      document: {
        ...emptyPromptDocument(),
        parts: {
          ...emptyPromptDocument().parts,
          subject: { itemId: null, text: "missed external update" },
        },
      },
    });
    expect(await value(page)).toBe("my text survives a concurrent deletion");
    await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
    await page.getByText("This field's library is empty.", { exact: true }).waitFor();
    const missed = createPromptItem();
    await apply(f, missed);
    expect(
      await page.getByRole("button", { name: `Use ${missed.item.name}`, exact: true }).count(),
    ).toBe(0);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:prompts-reconnected"),
    );
    await page.getByRole("button", { name: `Use ${missed.item.name}`, exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Choose Subject", exact: true })
          .evaluate((element) => element === window.document.activeElement),
      )
      .toBe(true);
    await expect.poll(() => value(page)).toBe("missed external update");
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("the full desktop editor and picker keep multiline text, output and keyboard focus in both appearances", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await ready(page);
    const client = await f.connect();
    const long =
      "Synthetic reading text with enough words to wrap naturally across the entire editor. ".repeat(
        18,
      );
    const document = {
      ...emptyPromptDocument(),
      parts: Object.fromEntries(
        PROMPT_FIELDS.map((field) => [field, { itemId: null, text: `${field} ${long}` }]),
      ) as ReturnType<typeof emptyPromptDocument>["parts"],
    };
    await apply(f, {
      action: "update-workspace",
      expectedRevision: 0,
      requestId: randomUUID(),
      document,
    });
    await expect.poll(() => value(page)).toBe(document.parts.subject.text);
    const create = createPromptItem();
    await client.prompts({
      ...create,
      item: { ...create.item, fragment: long, description: long.slice(0, 1800) },
    });
    await client.prompts({
      action: "set-image",
      id: create.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      image: { mediaType: "image/png", base64: examplePng(0) },
    });
    for (let index = 1; index <= 2; index++) {
      const other = createPromptItem();
      await client.prompts({
        ...other,
        item: { ...other.item, name: `Synthetic comparison ${index}` },
      });
      await client.prompts({
        action: "set-image",
        id: other.id,
        expectedRevision: 1,
        requestId: randomUUID(),
        image: { mediaType: "image/png", base64: examplePng(index) },
      });
    }
    const evidence: unknown[] = [];
    for (const appearance of ["light", "dark"] as const)
      for (const size of [
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await page.keyboard.press("ControlOrMeta+,");
        await page.getByLabel("Search settings").fill("appearance");
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .waitFor({ state: "hidden" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
        await page.setViewportSize(size);
        const measurements = await page.evaluate(() => {
          const textarea = window.document.querySelector<HTMLTextAreaElement>(
            ".prompt-field-subject textarea",
          )!;
          const style = getComputedStyle(textarea);
          const output = window.document.querySelector(".prompt-output")!.getBoundingClientRect();
          const rect = textarea.getBoundingClientRect();
          return {
            viewport: { width: innerWidth, height: innerHeight },
            textareaHeight: rect.height,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            visibleLines:
              (textarea.clientHeight -
                parseFloat(style.paddingTop) -
                parseFloat(style.paddingBottom)) /
              parseFloat(style.lineHeight),
            output: { x: output.x, y: output.y, width: output.width, height: output.height },
            fields: [...window.document.querySelectorAll(".prompt-field textarea")].length,
          };
        });
        expect(measurements.fontSize).toBe("16px");
        expect(measurements.fields).toBe(7);
        expect(measurements.visibleLines).toBeGreaterThanOrEqual(
          size.height === 1080 ? 8.5 : size.height === 900 ? 6.5 : 4.5,
        );
        expect(measurements.output.height).toBeGreaterThan(130);
        expect(measurements.output.y + measurements.output.height).toBeLessThanOrEqual(size.height);
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.SCOPE_TEST_SCREENSHOTS,
              `prompts-${size.width}-${appearance}.png`,
            ),
          });
        }
        await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
        await page.getByRole("button", { name: `Use ${create.item.name}`, exact: true }).waitFor();
        expect(
          await page.getByRole("dialog", { name: "Subject", exact: true }).boundingBox(),
        ).toMatchObject({ x: 0, y: 0, ...size });
        expect(
          await page
            .locator(".prompt-picker-item")
            .filter({
              has: page.getByRole("button", { name: `Use ${create.item.name}`, exact: true }),
            })
            .locator(".prompt-item-fragment")
            .textContent(),
        ).toBe(long);
        const image = await page.locator(".prompt-example").first().boundingBox();
        expect(image!.height).toBeGreaterThanOrEqual(200);
        evidence.push({ appearance, ...measurements, picker: { viewport: size, image } });
        if (process.env.SCOPE_TEST_SCREENSHOTS)
          await page.screenshot({
            path: join(
              process.env.SCOPE_TEST_SCREENSHOTS,
              `prompts-picker-${size.width}-${appearance}.png`,
            ),
          });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        expect(await value(page)).toBe(document.parts.subject.text);
      }
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await page.getByRole("button", { name: "Choose Subject", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(await page.getByRole("navigation", { name: "Open artifacts" }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.getByRole("navigation", { name: "Open artifacts" }).waitFor();
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await writeFile(
        join(process.env.SCOPE_TEST_SCREENSHOTS, "prompts-measurements.json"),
        JSON.stringify(evidence, null, 2),
      );
    expect(PROMPT_STRUCTURE.fields).toHaveLength(7);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
