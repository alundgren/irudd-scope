import { expect, test } from "vite-plus/test";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";

const MARKER = "FOLDER-MARKER-7f3a9c";

type Receipt = { tabId: string; machine: string; path: string; created: boolean };

async function syntheticFolders(base: string) {
  const work = join(base, "work");
  const app = join(work, "app");
  await mkdir(join(app, "src"), { recursive: true });
  await mkdir(join(app, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(app, ".git"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
  for (const name of ["other", "kept", "old"]) await mkdir(join(work, name));
  await writeFile(join(app, ".gitignore"), "node_modules/\n");
  await writeFile(join(app, "src", "app.ts"), `export const marker = "${MARKER}";\n`);
  await writeFile(join(app, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await writeFile(join(base, "outside", "secret.txt"), "outside the folder\n");
  await symlink(join(base, "outside"), join(app, "link-out"));
  await symlink(app, join(work, "app-link"));
  return { work, app };
}

const selectedTab = (page: Page) =>
  page.locator('[role="tab"][aria-selected="true"]').allTextContents();

test(
  "an agent opens its folder as one live Folder tab that stays inside the folder and survives restart",
  { tags: ["folders-stay-inside", "tabs-stay-put", "survives-restart"], timeout: 180_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const { work, app } = await syntheticFolders(f.directory);
    const open = async (...args: string[]) =>
      JSON.parse((await f.cli("folder", "open", ...args)).stdout) as Receipt;
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      const client = await f.connect();
      await client.publish(
        "notes",
        {
          title: "Notes",
          kind: "text",
          mediaType: "text/plain",
          fileName: "notes.txt",
          expectedRevision: 0,
        },
        Buffer.from("Synthetic notes"),
      );
      await page.getByRole("tab", { name: "Notes", exact: true }).waitFor();
      expect(await selectedTab(page)).toEqual(["Notes"]);

      // A new Folder tab is unread at the end of the strip and does not take selection.
      const first = await open(app, "--title", "Login fix");
      expect(first).toEqual({
        tabId: first.tabId,
        machine: "local",
        path: await realpath(app),
        created: true,
      });
      const folderTab = page.getByRole("tab", { name: "Login fix", exact: true });
      await folderTab.waitFor();
      expect(await page.getByRole("tab").allTextContents()).toEqual(["Notes", "Login fix"]);
      expect(await selectedTab(page)).toEqual(["Notes"]);
      expect(
        await page.locator(".artifact-tab", { has: folderTab }).locator(".unread-dot").count(),
      ).toBe(1);

      // Every spelling of the same folder reaches the same tab.
      const variants = [`${app}/`, `${work}/./app/.`, join(work, "app-link")];
      if (existsSync(app.toUpperCase())) variants.push(app.toUpperCase());
      for (const variant of variants)
        expect(await open(variant)).toMatchObject({ tabId: first.tabId, created: false });
      // Two agents opening the same new folder at once share one tab.
      const pair = await Promise.all([open(join(work, "other")), open(join(work, "other"))]);
      expect(pair[0].tabId).toBe(pair[1].tabId);
      expect(pair.filter((receipt) => receipt.created)).toHaveLength(1);
      // A local command that claims a remote machine still opens the local tab.
      const { endpoint, token } = JSON.parse(await readFile(f.connectionFile, "utf8"));
      const claimed = await fetch(`${endpoint}/v1/folders/open`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: app, machine: "0f0e0d0c-0b0a-4908-8706-050403020100" }),
      }).then((response) => response.json());
      expect(claimed).toMatchObject({ tabId: first.tabId, machine: "local", created: false });

      // A renderer save made before a rename cannot restore the old title.
      const before = await page.evaluate(() => window.scope.workspace());
      await open(app, "--title", "Login fix v2");
      await page.getByRole("tab", { name: "Login fix v2", exact: true }).waitFor();
      await page.evaluate((stale) => window.scope.saveWorkspace(stale!), before);
      const saved = await page.evaluate(() => window.scope.workspace());
      expect(saved!.tabs.find((tab) => tab.id === first.tabId)?.title).toBe("Login fix v2");

      expect(pair[0].tabId).not.toBe(first.tabId);
      await page.getByRole("tab", { name: "other", exact: true }).waitFor();

      // A bookmarked tab closed from the strip comes back at the end without selection.
      const kept = await open(join(work, "kept"));
      await page.getByRole("button", { name: "Keep permanently: kept", exact: true }).click();
      await page.getByRole("button", { name: "Close kept", exact: true }).click();
      await page.getByRole("tab", { name: "kept", exact: true }).waitFor({ state: "hidden" });
      expect(await open(join(work, "kept"))).toMatchObject({ tabId: kept.tabId, created: false });
      await page.getByRole("tab", { name: "kept", exact: true }).waitFor();
      expect((await page.getByRole("tab").allTextContents()).at(-1)).toBe("kept");
      expect(await selectedTab(page)).toEqual(["Notes"]);

      // The tree lists only opened folders, hides .git and ignored files, and never opens a link out.
      await page.getByRole("tab", { name: "Login fix v2", exact: true }).click();
      const tree = page.getByRole("tree", { name: "Folder contents" });
      const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
      await item("src").waitFor();
      expect(
        await tree.getByRole("treeitem").evaluateAll((rows) => rows.map((row) => row.ariaLabel)),
      ).toEqual(["src", ".gitignore", "link-out, link outside this folder"]);
      await page.getByLabel("Show ignored files").check();
      await item("node_modules, ignored").waitFor();
      await page.getByLabel("Show ignored files").uncheck();
      await item("node_modules, ignored").waitFor({ state: "hidden" });
      await item("link-out, link outside this folder").click();
      expect(
        await item("link-out, link outside this folder").getAttribute("aria-expanded"),
      ).toBeNull();
      await item("src").click();
      await item("app.ts").click();
      expect(await item("app.ts").getAttribute("aria-selected")).toBe("true");

      // Main's IPC handlers reject every escape and read exactly the requested bytes.
      const escapes = await page.evaluate(async (tabId) => {
        const outcome = (task: Promise<unknown>) =>
          task.then(
            (value) => JSON.stringify(value),
            () => "rejected",
          );
        return {
          parent: await outcome(window.scope.folderList({ tabId, path: "..", showIgnored: false })),
          absolute: await outcome(
            window.scope.folderList({ tabId, path: "/etc", showIgnored: false }),
          ),
          link: await window.scope.folderList({ tabId, path: "link-out", showIgnored: false }),
          encoded: await window.scope.folderList({ tabId, path: "%2e%2e", showIgnored: false }),
          readParent: await outcome(
            window.scope.folderRead({ tabId, path: "../outside/secret.txt", start: 0, end: 100 }),
          ),
          readLink: await outcome(
            window.scope.folderRead({ tabId, path: "link-out/secret.txt", start: 0, end: 100 }),
          ),
          range: await window.scope
            .folderRead({ tabId, path: "src/app.ts", start: 22, end: 42 })
            .then(({ bytes, size }) => ({ text: new TextDecoder().decode(bytes), size })),
        };
      }, first.tabId);
      const source = await readFile(join(app, "src", "app.ts"));
      expect(escapes).toMatchObject({
        parent: "rejected",
        absolute: "rejected",
        link: { status: "outside" },
        encoded: { status: "missing" },
        readParent: "rejected",
        readLink: "rejected",
        range: { text: source.subarray(22, 42).toString(), size: source.length },
      });

      // Changes appear by themselves; a deleted selected file stays shown as deleted.
      await writeFile(join(app, "src", "new.ts"), "export {};\n");
      await item("new.ts").waitFor();
      await rm(join(app, "src", "app.ts"));
      await item("app.ts, deleted").waitFor();

      // The tab explains a missing folder and recovers when the folder returns.
      await rename(app, `${app}-moved`);
      await page.getByText("This folder no longer exists").waitFor();
      expect(await tree.count()).toBe(0);
      await rename(`${app}-moved`, app);
      await item("new.ts").waitFor();

      await application.close();
      await writeFile(join(app, "src", "later.ts"), "export {};\n");
      application = await f.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      await page.getByRole("tab", { name: "kept", exact: true }).waitFor();
      expect(await page.getByRole("tab").allTextContents()).toEqual([
        "Notes",
        "Login fix v2",
        "other",
        "kept",
      ]);
      await page.getByRole("tab", { name: "Login fix v2", exact: true }).click();
      const restored = page.getByRole("tree", { name: "Folder contents" });
      await restored.getByRole("treeitem", { name: "later.ts", exact: true }).waitFor();
      await restored.getByRole("treeitem", { name: "app.ts, deleted", exact: true }).waitFor();

      // Restoring a trashed tab into an empty workspace leaves selection empty.
      const old = await open(join(work, "old"));
      await page.getByRole("tab", { name: "old", exact: true }).waitFor();
      for (const name of ["Notes", "Login fix v2", "other", "kept", "old"]) {
        await page.getByRole("button", { name: `Close ${name}`, exact: true }).click();
        await page.getByRole("tab", { name, exact: true }).waitFor({ state: "hidden" });
      }
      expect(await selectedTab(page)).toEqual([]);
      expect(await open(join(work, "old"))).toMatchObject({ tabId: old.tabId, created: false });
      await page.getByRole("tab", { name: "old", exact: true }).waitFor();
      expect(await selectedTab(page)).toEqual([]);
    } finally {
      await application.close();
    }

    // Scope keeps only the tab records: no file bytes and no file lists.
    for (const directory of [f.settingsDirectory, join(f.settingsDirectory, "artifacts")])
      for (const name of await readdir(directory))
        if (/\.db(-wal)?$/.test(name)) {
          const bytes = await readFile(join(directory, name));
          for (const text of [MARKER, "new.ts", "later.ts", "left-pad", "secret.txt"])
            expect(bytes.includes(text), `${name} contains ${text}`).toBe(false);
        }
    await rm(f.directory, { recursive: true, force: true });
  },
);
