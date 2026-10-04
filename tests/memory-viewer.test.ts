import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { memoryFixture, MEMORY_REPOSITORY } from "./memory-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(extra: NodeJS.ProcessEnv = {}) {
  const memory = await memoryFixture(cleanup);
  await writeFile(
    join(memory.directory, "seed", "index.md"),
    "# Personal memory\n\n[Recovery](recovery.md)\n[Root note](/validation.md)\n[Missing](missing.md)\n[Web](https://example.com/docs)\n[Home](./)\n\n[Unsafe](javascript:alert(1))\n[Outside](../outside.md)\n",
  );
  await writeFile(
    join(memory.directory, "seed", "recovery.md"),
    "---\ntype: Rule\ntitle: Recovery\n---\n\n# Recovery\n\nRetry interrupted edits. [Validation](validation.md)\n",
  );
  await writeFile(
    join(memory.directory, "seed", "validation.md"),
    "---\ntype: Rule\ntitle: Validation\n---\n\n# Validation\n\nUse synthetic fixtures.\n",
  );
  await memory.git(join(memory.directory, "seed"), "add", ".");
  await memory.git(join(memory.directory, "seed"), "commit", "-m", "Add synthetic notes");
  await memory.git(join(memory.directory, "seed"), "push", "origin", "main");
  const desktop = await desktopFixture({
    env: { ...memory.env("mac", { extra }), SCOPE_MEMORY_DIR: memory.root("mac") },
  });
  let application = await desktop.launch();
  cleanup.push(() => application.close());
  let page = await application.firstWindow();
  page.setDefaultTimeout(8000);
  await page.evaluate(() => window.scope.setMemoryEnabled(true));
  await (await desktop.connect()).connectMemory(MEMORY_REPOSITORY);
  await expect
    .poll(
      () => page.evaluate(async () => (await window.scope.memory()).machines[0]?.status?.bundle),
      { timeout: 15000 },
    )
    .toBe("registered");
  const open = async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: "Personal memory", exact: true }).click();
  };
  return {
    memory,
    desktop,
    get application() {
      return application;
    },
    open,
    get page() {
      return page;
    },
    restart: async () => {
      await application.close();
      application = await desktop.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(8000);
    },
  };
}

test("Personal memory browses, searches, edits with conflict recovery, and opens graph nodes", async () => {
  const f = await fixture();
  await f.open();
  const page = f.page;
  await page.locator(".memory-wiki").getByRole("heading", { name: "Personal memory" }).waitFor();
  expect(await page.locator('.memory-wiki a[href^="javascript:"]').count()).toBe(0);
  expect(await page.locator('.memory-wiki a[href="../outside.md"]').count()).toBe(0);
  await page.locator(".memory-wiki").getByRole("link", { name: "Recovery", exact: true }).click();
  await page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  const draft = "---\ntype: Rule\ntitle: Recovery\n---\n\n# Recovery\n\nSaved by the wiki.\n";
  await page.getByLabel("Memory Markdown").fill(draft);
  await page.getByRole("button", { name: "Preview draft", exact: true }).click();
  await page
    .getByLabel("Draft preview")
    .getByRole("heading", { name: "Recovery", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved to personal memory" }).waitFor();
  expect(await readFile(join(f.memory.clone("mac"), "recovery.md"), "utf8")).toBe(draft);
  await page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  await page.getByLabel("Memory Markdown").fill(`${draft}\nUnsaved second edit.\n`);
  const external = `${draft}\nChanged by an agent.\n`;
  await writeFile(join(f.memory.clone("mac"), "recovery.md"), external);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "saved file changed" }).waitFor();
  expect(await page.getByLabel("Memory Markdown").inputValue()).toContain("Unsaved second edit");
  expect(await readFile(join(f.memory.clone("mac"), "recovery.md"), "utf8")).toBe(external);
  await page.getByRole("button", { name: "Compare saved version" }).click();
  await page
    .locator(".memory-comparison")
    .getByText("Changed by an agent.", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Use saved version as base", exact: true }).click();
  expect(await page.getByLabel("Memory Markdown").inputValue()).toContain("Unsaved second edit");
  await page.getByRole("button", { name: "Keep draft and confirm base", exact: true }).click();
  await writeFile(
    join(f.memory.clone("mac"), "recovery.md"),
    `${external}\nAnother concurrent edit.\n`,
  );
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "saved file changed" }).waitFor();
  await page.getByRole("button", { name: "Compare saved version" }).click();
  await page
    .locator(".memory-comparison")
    .getByText("Another concurrent edit.", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Use saved version as base", exact: true }).click();
  await page.getByRole("button", { name: "Keep draft and confirm base", exact: true }).click();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved to personal memory" }).waitFor();
  expect(await readFile(join(f.memory.clone("mac"), "recovery.md"), "utf8")).toContain(
    "Unsaved second edit",
  );
  await page.getByLabel("Search personal memory").fill("synthetic");
  await page.getByRole("button", { name: "Search memory", exact: true }).click();
  await page
    .locator(".memory-results")
    .getByRole("button", { name: "Validation", exact: true })
    .click();
  await page
    .locator(".memory-wiki")
    .getByRole("heading", { name: "Validation", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByRole("button", { name: "Open note Recovery", exact: true }).click();
  await page
    .locator(".memory-wiki")
    .getByRole("heading", { name: "Recovery", exact: true })
    .waitFor();
  for (const appearance of ["light", "dark"] as const) {
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("color scheme");
    await settings.getByLabel("Appearance", { exact: true }).selectOption(appearance);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    await page.setViewportSize(
      appearance === "light" ? { width: 1280, height: 820 } : { width: 620, height: 560 },
    );
    expect(await page.getByRole("button", { name: "Edit Markdown", exact: true }).isEnabled()).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, `memory-wiki-${appearance}.png`),
      });
    }
    await page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
    await page.getByRole("button", { name: "Preview draft", exact: true }).click();
    await page
      .getByLabel("Draft preview")
      .getByRole("heading", { name: "Recovery", exact: true })
      .waitFor();
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, `memory-editor-${appearance}.png`),
      });
    await page.getByRole("button", { name: "Compare saved version", exact: true }).click();
    await page.locator(".memory-comparison").waitFor();
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await page.locator(".memory-comparison").screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, `memory-comparison-${appearance}.png`),
      });
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    const node = page.getByRole("button", { name: "Open note Recovery", exact: true });
    await node.waitFor();
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, `memory-graph-${appearance}.png`),
      });
    await node.focus();
    await page.keyboard.press("Enter");
    await page
      .locator(".memory-wiki")
      .getByRole("heading", { name: "Recovery", exact: true })
      .waitFor();
  }
});

test("memory drafts survive tab close and restart, and disabling memory cannot apply a draft", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  await f.page.getByLabel("Memory Markdown").fill("# Retained draft\n\nDo not lose this edit.\n");
  await f.page.getByRole("button", { name: "Close Personal memory", exact: true }).click();
  await expect
    .poll(() => f.page.getByRole("tab", { name: "Personal memory", exact: true }).count())
    .toBe(0);
  await f.restart();
  expect(await f.page.getByRole("tab", { name: "Personal memory", exact: true }).count()).toBe(0);
  await f.open();
  await expect
    .poll(() => f.page.getByLabel("Memory Markdown").inputValue())
    .toContain("Do not lose this edit");
  await f.page.evaluate(() => window.scope.setMemoryEnabled(false));
  await expect
    .poll(() => f.page.getByRole("button", { name: "Save note", exact: true }).isDisabled())
    .toBe(true);
  expect(await f.page.getByLabel("Memory Markdown").inputValue()).toContain(
    "Do not lose this edit",
  );
  await f.page.getByRole("button", { name: "Copy draft", exact: true }).click();
  await f.memory.git(
    f.memory.directory,
    "clone",
    "--bare",
    f.memory.bare,
    join(f.memory.directory, "remotes", "other-memory.git"),
  );
  await f.page.evaluate(() => window.scope.setMemoryEnabled(true));
  await (await f.desktop.connect()).connectMemory("octo/other-memory");
  await expect
    .poll(() =>
      f.page.evaluate(async () => (await window.scope.memory()).machines[0]?.status?.repository),
    )
    .toBe("octo/other-memory");
  await f.page.getByText("This draft belongs to octo/personal-memory.", { exact: false }).waitFor();
  expect(await f.page.getByRole("button", { name: "Save note", exact: true }).isDisabled()).toBe(
    true,
  );
  expect(await f.page.getByLabel("Memory Markdown").inputValue()).toContain(
    "Do not lose this edit",
  );
  expect(await readFile(join(f.memory.clone("mac"), "index.md"), "utf8")).not.toContain(
    "Retained draft",
  );
});

test("unreadable OKF output leaves a visible retry and settings action", async () => {
  const f = await fixture({ FAKE_OKF_BAD_VIEWER_OUTPUT: "1" });
  await f.open();
  await f.page.getByRole("alert").waitFor();
  expect(await f.page.getByRole("button", { name: "Refresh memory" }).isEnabled()).toBe(true);
  expect(await f.page.getByRole("button", { name: "Memory settings" }).isVisible()).toBe(true);
});

test("a delayed comparison cannot replace a different note's draft", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  await f.application.evaluate(({ ipcMain }) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    const original = (
      ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers.get("scope:memory-command")!;
    const state = globalThis as typeof globalThis & {
      comparisonHeld?: boolean;
      releaseComparison?: () => void;
    };
    ipcMain.removeHandler("scope:memory-command");
    ipcMain.handle("scope:memory-command", async (event, command) => {
      const result = await original(event, command);
      if (command.action === "read" && command.path === "index.md") {
        ipcMain.removeHandler("scope:memory-command");
        ipcMain.handle("scope:memory-command", original);
        state.comparisonHeld = true;
        await new Promise<void>((resolve) => {
          state.releaseComparison = resolve;
        });
      }
      return result;
    });
  });
  await f.page.getByRole("button", { name: "Compare saved version", exact: true }).click();
  await expect
    .poll(() =>
      f.application.evaluate(
        () => (globalThis as typeof globalThis & { comparisonHeld?: boolean }).comparisonHeld,
      ),
    )
    .toBe(true);
  await f.page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await f.page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await f.page.locator(".memory-wiki").getByRole("link", { name: "Recovery", exact: true }).click();
  await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  await f.page.getByLabel("Memory Markdown").fill("# Retain the second note draft\n");
  await f.application.evaluate(() =>
    (globalThis as typeof globalThis & { releaseComparison?: () => void }).releaseComparison?.(),
  );
  await f.page.evaluate(async () => {
    const tab = (await window.scope.workspace())!.tabs.find((entry) => entry.type === "memory")!;
    await window.scope.memoryCommand({
      action: "read",
      tabId: tab.id,
      repository: "octo/personal-memory",
      path: "recovery.md",
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect(await f.page.locator(".memory-comparison").count()).toBe(0);
  expect(await f.page.getByLabel("Memory Markdown").inputValue()).toContain(
    "Retain the second note draft",
  );
  await f.page.getByRole("button", { name: "Compare saved version", exact: true }).click();
  await f.page
    .locator(".memory-comparison")
    .getByText("Retry interrupted edits.", { exact: false })
    .waitFor();
  expect(
    await f.page
      .locator(".memory-comparison")
      .getByText("# Personal memory", { exact: false })
      .count(),
  ).toBe(0);
});

test("a draft-state save failure prevents writing the personal memory file", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  await f.page.getByLabel("Memory Markdown").fill("# Keep this failed-save draft\n");
  const before = await readFile(join(f.memory.clone("mac"), "index.md"), "utf8");
  await f.application.evaluate(({ ipcMain }) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    const original = (
      ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers.get("scope:save-workspace")!;
    ipcMain.removeHandler("scope:save-workspace");
    ipcMain.handle("scope:save-workspace", () => {
      throw new Error("Synthetic draft-state save failure");
    });
    const state = globalThis as typeof globalThis & { restoreDraftSave?: () => void };
    state.restoreDraftSave = () => {
      ipcMain.removeHandler("scope:save-workspace");
      ipcMain.handle("scope:save-workspace", original);
    };
  });
  cleanup.push(() =>
    f.application.evaluate(() =>
      (globalThis as typeof globalThis & { restoreDraftSave?: () => void }).restoreDraftSave?.(),
    ),
  );
  await f.page.getByRole("button", { name: "Save note", exact: true }).click();
  await f.page.getByRole("alert").filter({ hasText: "Could not save the workspace." }).waitFor();
  expect(await readFile(join(f.memory.clone("mac"), "index.md"), "utf8")).toBe(before);
  expect(await f.page.getByLabel("Memory Markdown").inputValue()).toContain(
    "Keep this failed-save draft",
  );
  await f.application.evaluate(() =>
    (globalThis as typeof globalThis & { restoreDraftSave?: () => void }).restoreDraftSave?.(),
  );
  await f.page.getByRole("button", { name: "Save note", exact: true }).click();
  await f.page.getByRole("status").filter({ hasText: "Saved to personal memory" }).waitFor();
});

test("native wiki links stay within memory or open the default browser, and missing notes keep index recovery", async () => {
  const f = await fixture();
  await f.application.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { memoryExternalLinks?: string[] };
    state.memoryExternalLinks = [];
    shell.openExternal = async (url) => {
      state.memoryExternalLinks!.push(url);
    };
  });
  await f.open();
  await f.page
    .locator(".memory-wiki")
    .getByRole("link", { name: "Root note", exact: true })
    .click();
  await f.page
    .locator(".memory-wiki")
    .getByRole("heading", { name: "Validation", exact: true })
    .waitFor();
  await f.page.getByRole("button", { name: "Wiki index", exact: true }).click();
  await f.page.locator(".memory-wiki").getByRole("link", { name: "Web", exact: true }).click();
  await expect
    .poll(() =>
      f.application.evaluate(
        () =>
          (globalThis as typeof globalThis & { memoryExternalLinks?: string[] })
            .memoryExternalLinks,
      ),
    )
    .toEqual(["https://example.com/docs"]);
  expect(f.application.windows().length).toBe(1);
  await f.page.locator(".memory-wiki").getByRole("link", { name: "Missing", exact: true }).click();
  await f.page.getByRole("alert").filter({ hasText: "This note does not exist" }).waitFor();
  await f.page.getByRole("button", { name: "Wiki index", exact: true }).click();
  await f.page.locator(".memory-wiki").getByRole("link", { name: "Home", exact: true }).click();
  await f.page
    .locator(".memory-wiki")
    .getByRole("heading", { name: "Personal memory", exact: true })
    .waitFor();
});

test("inconsistent search and save replies preserve the editor draft", async () => {
  const f = await fixture({ FAKE_OKF_WRONG_SEARCH_OFFSET: "1", FAKE_OKF_WRONG_SAVE_HASH: "1" });
  await f.open();
  await f.page.getByLabel("Search personal memory").fill("synthetic");
  await f.page.getByRole("button", { name: "Search memory", exact: true }).click();
  await f.page.getByRole("alert").filter({ hasText: "unreadable memory data" }).waitFor();
  expect(await f.page.locator(".memory-results").count()).toBe(0);
  await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  await f.page.getByLabel("Memory Markdown").fill("# Preserve the submitted draft\n");
  await f.page.getByRole("button", { name: "Save note", exact: true }).click();
  await f.page.getByRole("alert").filter({ hasText: "unreadable memory data" }).waitFor();
  expect(await f.page.getByLabel("Memory Markdown").inputValue()).toContain(
    "Preserve the submitted draft",
  );
});

test("a failed saved-draft clear keeps the saved note's draft and permits a safe retry", async () => {
  const f = await fixture();
  await f.open();
  await f.page.locator(".memory-wiki").getByRole("link", { name: "Recovery", exact: true }).click();
  await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).click();
  const raw = "# Saved but retained draft\n";
  await f.page.getByLabel("Memory Markdown").fill(raw);
  await f.application.evaluate(({ ipcMain }) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const command = handlers.get("scope:memory-command")!;
    const save = handlers.get("scope:save-workspace")!;
    const state = globalThis as typeof globalThis & {
      savedReadHeld?: boolean;
      releaseSavedRead?: () => void;
      restoreSavedClear?: () => void;
    };
    let wrote = false;
    ipcMain.removeHandler("scope:memory-command");
    ipcMain.handle("scope:memory-command", async (event, input) => {
      const result = await command(event, input);
      if (input.action === "save") wrote = true;
      else if (input.action === "read" && wrote) {
        state.savedReadHeld = true;
        await new Promise<void>((resolve) => {
          state.releaseSavedRead = resolve;
        });
        ipcMain.removeHandler("scope:memory-command");
        ipcMain.handle("scope:memory-command", command);
      }
      return result;
    });
    ipcMain.removeHandler("scope:save-workspace");
    ipcMain.handle("scope:save-workspace", (event, workspace) => {
      if (
        wrote &&
        workspace.tabs.some(
          (tab: { type: string; state: { data: { draft?: unknown } } }) =>
            tab.type === "memory" && !tab.state.data.draft,
        )
      )
        throw new Error("Synthetic saved-draft clear failure");
      return save(event, workspace);
    });
    state.restoreSavedClear = () => {
      ipcMain.removeHandler("scope:save-workspace");
      ipcMain.handle("scope:save-workspace", save);
    };
  });
  cleanup.push(() =>
    f.application.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        releaseSavedRead?: () => void;
        restoreSavedClear?: () => void;
      };
      state.releaseSavedRead?.();
      state.restoreSavedClear?.();
    }),
  );
  await f.page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect
    .poll(() =>
      f.application.evaluate(
        () => (globalThis as typeof globalThis & { savedReadHeld?: boolean }).savedReadHeld,
      ),
    )
    .toBe(true);
  await f.page.getByRole("button", { name: "Wiki index", exact: true }).click();
  await f.page.getByRole("alert").filter({ hasText: "Wait for this note" }).waitFor();
  await f.application.evaluate(() =>
    (globalThis as typeof globalThis & { releaseSavedRead?: () => void }).releaseSavedRead?.(),
  );
  await f.page
    .getByRole("alert")
    .filter({ hasText: "file was saved, but Scope could not save the editor state" })
    .waitFor();
  expect(await f.page.getByLabel("Memory Markdown").inputValue()).toBe(raw);
  expect(await readFile(join(f.memory.clone("mac"), "recovery.md"), "utf8")).toBe(raw);
  const { createHash } = await import("node:crypto");
  await expect
    .poll(() =>
      f.page.evaluate(async () => {
        const tab = (await window.scope.workspace())!.tabs.find(
          (entry) => entry.type === "memory",
        )!;
        return tab.state.data;
      }),
    )
    .toMatchObject({
      path: "recovery.md",
      draft: {
        path: "recovery.md",
        raw,
        expectedHash: createHash("sha256").update(raw).digest("hex"),
      },
    });
  await f.application.evaluate(() =>
    (globalThis as typeof globalThis & { restoreSavedClear?: () => void }).restoreSavedClear?.(),
  );
  await f.page.getByRole("button", { name: "Save note", exact: true }).click();
  await f.page.getByRole("status").filter({ hasText: "Saved to personal memory" }).waitFor();
});

test("memory graph keeps zoom and scroll across tab switches and hiding", async () => {
  const f = await fixture();
  await f.open();
  await f.page.setViewportSize({ width: 620, height: 560 });
  await f.page.getByRole("button", { name: "Graph", exact: true }).click();
  await f.page.getByRole("button", { name: "Open note Recovery", exact: true }).waitFor();
  await f.page.getByRole("button", { name: "Zoom in graph", exact: true }).click();
  await f.page.locator(".memory-graph-scroll").evaluate((element) => {
    element.scrollLeft = 100;
    element.scrollTop = 100;
  });
  const position = await f.page
    .locator(".memory-graph-scroll")
    .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  await (
    await f.desktop.connect()
  ).publish(
    "other-note",
    {
      title: "Other note",
      kind: "text",
      mediaType: "text/plain",
      fileName: "note.txt",
      expectedRevision: 0,
    },
    Buffer.from("Another tab"),
  );
  await f.page.getByRole("tab", { name: "Other note", exact: true }).click();
  await f.page.getByRole("tab", { name: "Personal memory", exact: true }).click();
  await expect
    .poll(() => f.page.locator(".memory-graph-scroll > svg").getAttribute("style"))
    .toContain("150%");
  expect(
    await f.page
      .locator(".memory-graph-scroll")
      .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })),
  ).toEqual(position);
  await f.page.getByRole("button", { name: "Close Personal memory", exact: true }).click();
  await expect
    .poll(() => f.page.getByRole("tab", { name: "Personal memory", exact: true }).count())
    .toBe(0);
  await f.open();
  await expect
    .poll(() => f.page.locator(".memory-graph-scroll > svg").getAttribute("style"))
    .toContain("150%");
  expect(
    await f.page
      .locator(".memory-graph-scroll")
      .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })),
  ).toEqual(position);
});
