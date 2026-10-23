import { expect, test } from "vite-plus/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
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
    Array.from({ length: 400 }, (_, index) =>
      index === 249 ? "// todo: retry the request" : `export const line${index + 1} = ${index};`,
    ).join("\n"),
  );
  await writeFile(join(folder, "page.md"), "# Release notes\n\nShipped.\n");
  await writeFile(join(folder, "page.html"), "<!doctype html><h1>Synthetic page</h1>");
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
  await item("page.html").click();
  await preview("page.html").locator("iframe").waitFor();
  await item("archive.zip").click();
  await preview("archive.zip").getByText("Scope cannot preview this file.").waitFor();
  expect(await preview("archive.zip").locator("dd").first().textContent()).toBe("archive.zip");
  await item("logs").click();
  await item("huge.log").click();
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
  await tab.getByRole("button", { name: "Files", exact: true }).click();
}

test(
  "Folder tabs filter by name, search contents on the folder's machine, and preview files",
  { tags: ["folders-stay-inside", "survives-restart", "secrets-stay-secret"], timeout: 240_000 },
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

      // The filter text survives a restart.
      await page.getByLabel("Filter by file name").fill("readme");
      await expect.poll(() => page.getByRole("treeitem", { name: "README.md" }).count()).toBe(12);
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await page.getByRole("tab", { name: "Find", exact: true }).click();
      expect(await page.getByLabel("Filter by file name").inputValue()).toBe("readme");

      // The same journey on a paired remote goes through its hub's file routes.
      await page.evaluate((url) => window.scope.pairRemote(url), devbox.pairUrl);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.remotes()))[0]?.connection)
        .toBe("connected");
      await devbox.cli("folder", "open", folder, "--title", "Remote find");
      await useFolderTab(page, `${hostname()} · Remote find`, folder);

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
