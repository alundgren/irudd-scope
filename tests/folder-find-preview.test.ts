import { expect, test } from "vite-plus/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";

const exec = promisify(execFile);
const hubMain = resolve("apps/hub/dist/main.mjs");
const cliMain = resolve("packages/cli/dist/main.mjs");
const MARKER = "SEARCH-MARKER-5d1e";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/** A hub from the built executable, as a remote installs it. */
async function spawnedHub(directory: string) {
  const port = await freePort();
  const env = {
    ...process.env,
    SCOPE_HUB_DATA_DIR: join(directory, "data"),
    SCOPE_CONNECTION_FILE: join(directory, "connection.json"),
    SCOPE_ENDPOINT: undefined,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  const endpoint = `http://127.0.0.1:${port}`;
  await exec(
    process.execPath,
    [hubMain, "configure", "--endpoint", endpoint, "--port", String(port)],
    { env },
  );
  const child: ChildProcess = spawn(process.execPath, [hubMain, "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((done, fail) => {
    child.stdout!.on("data", (data: Buffer) => {
      if (data.toString().includes("Scope hub listening")) done();
    });
    child.once("exit", () => fail(new Error("The hub exited during startup.")));
  });
  const cli = async (...args: string[]) =>
    (await exec(process.execPath, [cliMain, ...args], { env, timeout: 15_000 })).stdout;
  const token = JSON.parse(await readFile(env.SCOPE_CONNECTION_FILE, "utf8")).token as string;
  const pairUrl = /irudd-scope:\/\/pair\S+/.exec(await cli("pair"))![0];
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  };
  return { endpoint, token, pairUrl, cli, stop };
}

/** Writes what the page's script can reach of the window that shows it. */
const REACH_PAGE = `<!doctype html><h1>Synthetic page</h1><p id="reach"></p><script>
const reach = (read) => { try { return String(read()); } catch { return "blocked"; } };
document.getElementById("reach").textContent = [
  reach(() => typeof parent.scope),
  reach(() => typeof top.scope),
  reach(() => typeof parent.scope.workspace),
].join(" ");
</script>`;

/** README.md in 12 folders, 40 notes with TODO, binary and large files, and an ignored folder. */
async function syntheticFolder(folder: string) {
  for (let index = 1; index <= 12; index++) {
    const directory = join(folder, "docs", index > 10 ? `deep/d${index}` : `d${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "README.md"), `# Readme ${index}\n`);
  }
  await mkdir(join(folder, "notes"));
  for (let index = 1; index <= 40; index++)
    await writeFile(
      join(folder, "notes", `n${index}.txt`),
      `note ${index}\n- TODO ${MARKER} ${index}\n`,
    );
  await mkdir(join(folder, "src"));
  await writeFile(
    join(folder, "src", "code.ts"),
    textWithBlankRuns(1200, (index) =>
      index === 249 ? "// todo: retry the request" : `export const line${index + 1} = ${index};`,
    ),
  );
  await writeFile(join(folder, "page.md"), "# Release notes\n\nShipped.\n");
  await writeFile(join(folder, "page.html"), REACH_PAGE);
  await writeFile(join(folder, "image.png"), Buffer.concat([PNG, Buffer.from("TODO")]));
  await writeFile(join(folder, "archive.zip"), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
  await mkdir(join(folder, "logs"));
  await writeFile(
    join(folder, "logs", "huge.log"),
    `TODO\n${"x".repeat(1023)}\n`.repeat(10 * 1024),
  );
  await mkdir(join(folder, "ignored"));
  await writeFile(join(folder, ".gitignore"), "ignored/\n");
  await writeFile(join(folder, "ignored", "skip.txt"), "TODO ignored\n");
  // Opening a FIFO for reading waits for a writer; search must skip it, not hang.
  if (process.platform !== "win32") await exec("mkfifo", [join(folder, "notes", "pipe-todo.txt")]);
}

/** Text with runs of empty lines across the 500-line blocks and a final newline. */
function textWithBlankRuns(count: number, line: (index: number) => string) {
  const blank = (index: number) => index % 500 >= 490 || index % 500 < 6;
  return `${Array.from({ length: count }, (_, index) => (blank(index) ? "" : line(index))).join("\n")}\n`;
}

/**
 * Select All in a text view copies exactly the file's text, both before scrolling, when
 * most lines are not numbered yet, and after scrolling to the end.
 */
async function copiesExactly(view: Locator, text: string) {
  const selected = () =>
    view.evaluate((element) => {
      getSelection()!.selectAllChildren(element);
      return getSelection()!.toString();
    });
  expect(await view.locator(".text-block[data-plain]").count()).toBeGreaterThan(0);
  expect(await selected()).toBe(text);
  await view.locator(".text-block").last().scrollIntoViewIfNeeded();
  await expect.poll(() => view.locator(".text-block").last().getAttribute("data-plain")).toBeNull();
  expect(await selected()).toBe(text);
}

/** What a case-insensitive grep finds in the files content search may read. */
async function referenceSearch(folder: string, query: string) {
  const found: string[] = [];
  for (const name of await readdir(folder, { recursive: true })) {
    const path = name.split("\\").join("/");
    if (path.startsWith("ignored/") || path.startsWith(".git/")) continue;
    const absolute = join(folder, path);
    const info = await stat(absolute);
    if (!info.isFile() || info.size > 1024 * 1024) continue;
    const bytes = await readFile(absolute);
    if (bytes.subarray(0, 8000).includes(0)) continue;
    bytes
      .toString()
      .split("\n")
      .forEach((line, index) => {
        if (line.toLowerCase().includes(query.toLowerCase())) found.push(`${path}:${index + 1}`);
      });
  }
  return found.sort();
}

async function useFolderTab(page: Page, label: string, folder: string) {
  await writeFile(join(folder, "page.md"), "# Release notes\n\nShipped.\n");
  await page.getByRole("tab", { name: label, exact: true }).click();
  const tab = page.getByRole("region", { name: `${label.split(" · ").at(-1)} folder` });
  const tree = tab.getByRole("tree", { name: "Folder contents" });
  const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
  const filter = tab.getByLabel("Filter by file name");
  const filterStatus = tab.locator(".folder-find").nth(0).locator(".folder-find-status");
  const searchStatus = tab.locator(".folder-find").nth(1).locator(".folder-find-status");

  // The filter shows every matching file with its folders open, then restores the tree.
  await item("src").click();
  await item("code.ts").waitFor();
  await filter.fill("readme");
  await expect.poll(() => tree.getByRole("treeitem", { name: "README.md" }).count()).toBe(12);
  await expect.poll(() => filterStatus.textContent()).toBe("12 files");
  expect(await item("deep").getAttribute("aria-expanded")).toBe("true");
  expect(await item("code.ts").count()).toBe(0);
  // A new folder's files are found even when they have no change events of their own.
  await mkdir(join(folder, "late", "inner"), { recursive: true });
  await writeFile(join(folder, "late", "inner", "README.md"), "# Late\n");
  await expect.poll(() => tree.getByRole("treeitem", { name: "README.md" }).count()).toBe(13);
  await rm(join(folder, "late"), { recursive: true });
  await expect.poll(() => tree.getByRole("treeitem", { name: "README.md" }).count()).toBe(12);
  await filter.fill("");
  await item("code.ts").waitFor();
  expect(await item("src").getAttribute("aria-expanded")).toBe("true");
  expect(await item("docs").getAttribute("aria-expanded")).toBe("false");

  // Previews use the published-file viewers and show what other files are.
  const preview = (name: string) => tab.getByRole("region", { name: `Preview of ${name}` });
  await item("page.md").click();
  await preview("page.md").getByRole("heading", { name: "Release notes" }).waitFor();
  await item("image.png").click();
  await preview("image.png").getByRole("img", { name: "image.png" }).waitFor();
  // A folder's HTML runs its scripts but cannot reach Scope; published HTML can.
  await item("page.html").click();
  await expect
    .poll(() => preview("page.html").frameLocator("iframe").locator("#reach").textContent())
    .toBe("blocked blocked blocked");
  await item("archive.zip").click();
  await preview("archive.zip").getByText("Scope cannot preview this file.").waitFor();
  expect(await preview("archive.zip").locator("dd").first().textContent()).toBe("archive.zip");
  await item("logs").click();
  await item("huge.log").click();
  await preview("huge.log").getByText("Showing the first 2.0 MiB of 10.0 MiB.").waitFor();
  // Moving the file's folder away deletes the file; moving it back shows it again.
  await rename(join(folder, "logs"), join(folder, "logs-moved"));
  await preview("huge.log").getByText("This file was deleted.").waitFor();
  await rename(join(folder, "logs-moved"), join(folder, "logs"));
  await preview("huge.log").getByText("Showing the first 2.0 MiB of 10.0 MiB.").waitFor();
  await item("page.md").click();
  await writeFile(join(folder, "page.md"), "# Updated notes\n");
  await preview("page.md").getByRole("heading", { name: "Updated notes" }).waitFor();

  // Content search runs on the folder's machine and opens a match at its line.
  await tab.getByRole("button", { name: "Search", exact: true }).click();
  await tab.getByLabel("Search file contents").fill("TODO");
  const results = tab.getByRole("list", { name: "Search results" });
  const expected = await referenceSearch(folder, "TODO");
  expect(expected).toHaveLength(41);
  await expect.poll(() => searchStatus.textContent()).toBe("41 matches");
  expect((await results.locator(".folder-search-place").allTextContents()).sort()).toEqual(
    expected,
  );
  await results.getByRole("button", { name: /^src\/code\.ts:250/ }).click();
  const current = preview("code.ts").locator(".text-line[aria-current]");
  expect(await current.getAttribute("data-line")).toBe("250");
  expect(
    await current.evaluate((line) => {
      const body = line.closest(".folder-preview-body")!.getBoundingClientRect();
      const box = line.getBoundingClientRect();
      return box.top >= body.top && box.bottom <= body.bottom;
    }),
  ).toBe(true);
  // Lines away from the view are still copied.
  const code = await readFile(join(folder, "src", "code.ts"), "utf8");
  await copiesExactly(preview("code.ts").locator(".text-document"), code);
  // A match in a closed folder that the filter hides opens the folder and shows all files.
  await tab.getByRole("button", { name: "Files", exact: true }).click();
  await filter.fill("page");
  await expect.poll(() => filterStatus.textContent()).toBe("2 files");
  await tab.getByRole("button", { name: "Search", exact: true }).click();
  await results.getByRole("button", { name: /^notes\/n1\.txt:2/ }).click();
  await tab.getByRole("button", { name: "Files", exact: true }).click();
  await expect
    .poll(() => filterStatus.textContent())
    .toBe("Showing all files so n1.txt is visible.Filter again");
  expect(await item("n1.txt").getAttribute("aria-selected")).toBe("true");
  expect(await item("notes").getAttribute("aria-expanded")).toBe("true");
  await filter.fill("");
}

/**
 * A remote directory with more entries than one listing returns cannot be kept as a path
 * list, so the filter asks the remote and asks again when files change.
 */
/**
 * A folder that search has listed but not yet entered is swapped for a link into `.git`.
 * The search must not follow it: `.git` content never appears, under any path.
 */
async function searchIgnoresSwappedLinks(page: Page, folder: string, open: () => Promise<unknown>) {
  await mkdir(join(folder, "aaa"), { recursive: true });
  await mkdir(join(folder, "zzz-dir"));
  await mkdir(join(folder, ".git"));
  await writeFile(join(folder, "seed.txt"), "GITSWAP root\n");
  await writeFile(join(folder, "zzz-dir", "inside.txt"), "GITSWAP inside\n");
  await writeFile(join(folder, ".git", "secret.txt"), "GITSWAP GIT-INTERNAL\n");
  // Reading these first keeps the search busy until the swap has happened.
  for (let index = 0; index < 20_000; index += 1000)
    await Promise.all(
      Array.from({ length: 1000 }, (_, offset) =>
        writeFile(join(folder, "aaa", `f${index + offset}.txt`), "x\n"),
      ),
    );
  await open();
  await page.getByRole("tab", { name: "Swap", exact: true }).click();
  const tab = page.getByRole("region", { name: "Swap folder" });
  await tab.getByRole("tree", { name: "Folder contents" }).waitFor();
  await tab.getByRole("button", { name: "Search", exact: true }).click();
  await tab.getByLabel("Search file contents").fill("GITSWAP");
  await tab.getByText("Searching…").waitFor();
  await rename(join(folder, "zzz-dir"), join(folder, "zzz-moved"));
  await symlink(join(folder, ".git"), join(folder, "zzz-dir"));
  const status = tab.locator(".folder-find").nth(1).locator(".folder-find-status");
  await expect.poll(() => status.textContent(), { timeout: 30_000 }).toMatch(/match/);
  const results = tab.getByRole("list", { name: "Search results" });
  expect(await results.locator(".folder-search-place").allTextContents()).toEqual(["seed.txt:1"]);
  expect(await results.textContent()).not.toContain("GIT-INTERNAL");
}

async function filterOnTheMachine(page: Page, label: string, folder: string, machine: string) {
  await page.getByRole("tab", { name: label, exact: true }).click();
  const tab = page.getByRole("region", { name: `${label.split(" · ").at(-1)} folder` });
  const tree = tab.getByRole("tree", { name: "Folder contents" });
  const filterStatus = tab.locator(".folder-find").nth(0).locator(".folder-find-status");
  await tab.getByLabel("Filter by file name").fill("readme");
  const asks = `This folder has too many files to list, so Scope asks ${machine} for matching names.`;
  // Listing 50,001 entries on the remote takes a few seconds.
  await expect.poll(() => filterStatus.textContent(), { timeout: 30_000 }).toBe(`${asks} 1 file`);
  await writeFile(join(folder, "later-README.md"), "# Later\n");
  await expect.poll(() => filterStatus.textContent(), { timeout: 10_000 }).toBe(`${asks} 2 files`);
  expect(await tree.getByRole("treeitem").count()).toBe(2);
}

test(
  "Folder tabs filter by name, search contents on the folder's machine, and preview files",
  {
    tags: [
      "folders-stay-inside",
      "survives-restart",
      "secrets-stay-secret",
      "html-runs-like-a-page",
    ],
    timeout: 240_000,
  },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const folder = join(f.directory, "work", "find");
    await syntheticFolder(folder);
    const devbox = await spawnedHub(join(f.directory, "devbox"));
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await f.cli("folder", "open", folder, "--title", "Find");
      await useFolderTab(page, "Find", folder);
      const swap = join(f.directory, "work", "swap");
      await searchIgnoresSwappedLinks(page, swap, () =>
        f.cli("folder", "open", swap, "--title", "Swap"),
      );

      // A published text file copies whole, including lines that were never scrolled to.
      const notes = textWithBlankRuns(1600, (index) => `published line ${index + 1}`);
      const client = await f.connect();
      await client.publish(
        "long-notes",
        {
          title: "Long notes",
          kind: "text",
          mediaType: "text/plain",
          fileName: "long-notes.txt",
          expectedRevision: 0,
        },
        Buffer.from(notes),
      );
      await page.getByRole("tab", { name: "Long notes", exact: true }).click();
      const published = '[role="tabpanel"][aria-label="Long notes"] .text-document';
      await page.locator(published).waitFor();
      await copiesExactly(page.locator(published), notes);
      await client.publish(
        "reach-page",
        {
          title: "Reach page",
          kind: "html",
          mediaType: "text/html",
          fileName: "reach.html",
          expectedRevision: 0,
        },
        Buffer.from(REACH_PAGE),
      );
      await page.getByRole("tab", { name: "Reach page", exact: true }).click();
      await expect
        .poll(() => page.frameLocator('iframe[title="Reach page"]').locator("#reach").textContent())
        .toBe("object object function");

      // The filter text survives a restart.
      await page.getByRole("tab", { name: "Find", exact: true }).click();
      await page
        .getByRole("region", { name: "Find folder" })
        .getByLabel("Filter by file name")
        .fill("readme");
      await expect
        .poll(() =>
          page
            .getByRole("region", { name: "Find folder" })
            .getByRole("treeitem", { name: "README.md" })
            .count(),
        )
        .toBe(12);
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await page.getByRole("tab", { name: "Find", exact: true }).click();
      expect(
        await page
          .getByRole("region", { name: "Find folder" })
          .getByLabel("Filter by file name")
          .inputValue(),
      ).toBe("readme");

      // The same journey on a paired remote goes through its hub's file routes.
      await page.evaluate((url) => window.scope.pairRemote(url), devbox.pairUrl);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.remotes()))[0]?.connection)
        .toBe("connected");
      await devbox.cli("folder", "open", folder, "--title", "Remote find");
      await useFolderTab(page, `${hostname()} · Remote find`, folder);

      const wide = join(f.directory, "work", "wide");
      await mkdir(wide);
      await writeFile(join(wide, "README.md"), "# Wide\n");
      for (let index = 0; index <= 50_000; index += 1000)
        await Promise.all(
          Array.from({ length: 1000 }, (_, offset) =>
            writeFile(join(wide, `f${index + offset}.txt`), ""),
          ),
        );
      await devbox.cli("folder", "open", wide, "--title", "Wide");
      await filterOnTheMachine(page, `${hostname()} · Wide`, wide, hostname());

      // The hub's search route refuses the publishing token.
      const response = await fetch(`${devbox.endpoint}/v1/relay/folders/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${devbox.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ root: await realpath(folder), query: "TODO", showIgnored: false }),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(MARKER);
    } finally {
      await application.close();
      await devbox.stop();
    }

    // Search results and path lists are never stored.
    for (const directory of [f.settingsDirectory, join(f.settingsDirectory, "artifacts")])
      for (const name of await readdir(directory))
        if (/\.db(-wal)?$/.test(name)) {
          const bytes = await readFile(join(directory, name));
          for (const text of [MARKER, "n17.txt", "README.md"])
            expect(bytes.includes(text), `${name} contains ${text}`).toBe(false);
        }
    await rm(f.directory, { recursive: true, force: true });
  },
);
