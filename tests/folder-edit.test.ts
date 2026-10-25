import { expect, test } from "vite-plus/test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";
import { spawnedHub } from "./hub-fixture.ts";

const MARKER = "EDIT-MARKER-4b9e";

async function makeFolder(folder: string) {
  await mkdir(join(folder, "docs"), { recursive: true });
  await writeFile(join(folder, "docs", "notes.md"), "# Notes\n\nfirst line\n");
  await writeFile(join(folder, "windows.txt"), "﻿one\r\ntwo\r\n");
}

/** Edits, saves, and a refused stale save of `docs/notes.md` in one Folder tab. */
async function editJourney(page: Page, label: string, folder: string) {
  const region = page.getByRole("region", { name: `${label.split(" · ").at(-1)} folder` });
  const notes = join(folder, "docs", "notes.md");
  await page.getByRole("tab", { name: label, exact: true }).click();
  await region.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = region.getByRole("textbox", { name: "Edit notes.md" });
  await expect.poll(() => editor.inputValue()).toBe("# Notes\n\nfirst line\n");
  await editor.fill(`# Notes\n\n${MARKER}\n`);
  await region.getByRole("treeitem", { name: "notes.md, unsaved changes" }).waitFor();
  await editor.press("ControlOrMeta+s");
  await expect.poll(() => readFile(notes, "utf8")).toBe(`# Notes\n\n${MARKER}\n`);
  await region.getByRole("treeitem", { name: "notes.md", exact: true }).waitFor();

  // A change on the folder's machine reloads an editor without unsaved changes.
  await writeFile(notes, "# Changed elsewhere\n");
  await expect.poll(() => editor.inputValue(), { timeout: 10_000 }).toBe("# Changed elsewhere\n");

  // With unsaved changes the newer file is kept until the person chooses to replace it.
  await editor.fill("# Mine\n");
  await writeFile(notes, "# Newer elsewhere\n");
  await region.getByText("notes.md changed on its machine since you started editing.").waitFor();
  expect(await region.getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(true);
  await editor.press("ControlOrMeta+s");
  expect(await readFile(notes, "utf8")).toBe("# Newer elsewhere\n");
  await region.getByRole("button", { name: "Overwrite with my changes" }).click();
  await expect.poll(() => readFile(notes, "utf8")).toBe("# Mine\n");

  await region.getByRole("button", { name: "Done", exact: true }).click();
  await region
    .getByRole("region", { name: "Preview of notes.md" })
    .getByRole("heading", { name: "Mine" })
    .waitFor();
}

test(
  "Folder tab files are edited in place on the folder's machine without replacing newer changes, and previews expand to fill the tab",
  { tags: ["folders-stay-inside", "no-lost-updates"], timeout: 240_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const local = join(f.directory, "work", "app");
    const remote = join(f.directory, "work", "remote-app");
    await makeFolder(local);
    await makeFolder(remote);
    const devbox = await spawnedHub(join(f.directory, "devbox"));
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await f.cli("folder", "select", local, "docs/notes.md", "--title", "App");
      await page.getByRole("tab", { name: "App", exact: true }).click();
      const region = page.getByRole("region", { name: "App folder" });
      const tree = region.getByRole("tree", { name: "Folder contents" });
      await region
        .getByRole("region", { name: "Preview of notes.md" })
        .getByRole("heading", { name: "Notes" })
        .waitFor();

      // Expanding hides the tree; the same button or Escape brings it back.
      await region.getByRole("button", { name: "Expand the preview" }).click();
      await tree.waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await tree.waitFor();
      await region.getByRole("button", { name: "Expand the preview" }).click();
      await region.getByRole("button", { name: "Show the file tree" }).click();
      await tree.waitFor();

      await editJourney(page, "App", local);

      // Saving keeps the file's own line endings and byte order mark.
      await tree.getByRole("treeitem", { name: "windows.txt", exact: true }).click();
      await region.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = region.getByRole("textbox", { name: "Edit windows.txt" });
      await expect.poll(() => editor.inputValue()).toBe("one\ntwo\n");
      await editor.fill("one\ntwo\nthree\n");
      await region.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => readFile(join(local, "windows.txt"), "utf8"))
        .toBe("﻿one\r\ntwo\r\nthree\r\n");

      // Unsaved changes stay while other files are shown, and closing the tab waits for them.
      await editor.fill("unsaved\n");
      await tree.getByRole("treeitem", { name: "notes.md", exact: true }).click();
      await tree.getByRole("treeitem", { name: "windows.txt, unsaved changes" }).click();
      await expect.poll(() => editor.inputValue()).toBe("unsaved\n");
      await page.getByRole("button", { name: "Close App", exact: true }).click();
      await region
        .getByText("Save or discard your changes to windows.txt before closing.")
        .waitFor();
      expect(await page.getByRole("tab", { name: "App", exact: true }).isVisible()).toBe(true);
      await region.getByRole("button", { name: "Discard", exact: true }).click();
      expect(await readFile(join(local, "windows.txt"), "utf8")).toBe("﻿one\r\ntwo\r\nthree\r\n");

      await page.evaluate((url) => window.scope.pairRemote(url), devbox.pairUrl);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.remotes()))[0]?.connection)
        .toBe("connected");
      await devbox.cli("folder", "select", remote, "docs/notes.md", "--title", "Remote app");
      await editJourney(page, `${hostname()} · Remote app`, remote);
    } finally {
      await application.close();
      await devbox.stop();
    }

    // Edited text is written only to the folder; Scope stores no copy.
    const databases = [
      ...[f.settingsDirectory, join(f.settingsDirectory, "artifacts")].map((directory) =>
        readdir(directory).then((names) => names.map((name) => join(directory, name))),
      ),
      readdir(join(f.directory, "devbox", "data")).then((names) =>
        names.map((name) => join(f.directory, "devbox", "data", name)),
      ),
    ];
    for (const path of (await Promise.all(databases)).flat())
      if (/\.db(-wal)?$/.test(path))
        expect((await readFile(path)).includes(MARKER), `${path} contains the edit`).toBe(false);
    await rm(f.directory, { recursive: true, force: true });
  },
);
