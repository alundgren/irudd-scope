import { expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
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
import { hostname } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";
import { cliMain, spawnedHub } from "./hub-fixture.ts";

const MARKER = "DROP-MARKER-7c3a";
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Runs `folder watch` and collects its lines until it is stopped. */
async function startWatch(env: NodeJS.ProcessEnv, folder: string) {
  const child = spawn(process.execPath, [cliMain, "folder", "watch", folder], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  await new Promise<void>((done, fail) => {
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.includes("Watching the Folder tab")) done();
    });
    child.once("exit", () => fail(new Error(`folder watch exited early: ${stderr}`)));
  });
  return {
    dropped: () =>
      stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; paths?: string[] })
        .filter((event) => event.type === "dropped"),
    stop: () => child.kill(),
  };
}

/**
 * Drops files from this computer on a tree row, or on the tree's empty space. The files
 * come from a file input, so they carry real paths like files dragged from Finder.
 */
async function dropFiles(page: Page, tree: string, row: string | null, paths: string[]) {
  const input = page.locator("#scope-test-drop");
  if (!(await input.count()))
    await page.evaluate(() => {
      const element = document.createElement("input");
      element.type = "file";
      element.multiple = true;
      element.id = "scope-test-drop";
      element.hidden = true;
      document.body.append(element);
    });
  await input.setInputFiles(paths);
  await page.evaluate(
    ({ tree, row }) => {
      const files = (document.querySelector("#scope-test-drop") as HTMLInputElement).files!;
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      const region = document.querySelector(`[aria-label="${tree}"]`)!;
      const target = row
        ? region.querySelector(`[role="treeitem"][aria-label="${row}"]`)!
        : region.querySelector('[role="tree"] > div')!;
      for (const type of ["dragenter", "dragover", "drop"])
        target.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
    },
    { tree, row },
  );
}

/** Lists every file below a folder, including staged copies that were left behind. */
const everything = async (folder: string) =>
  (await readdir(folder, { recursive: true })).map((name) => name.split("\\").join("/")).sort();

async function makeFolder(folder: string) {
  await mkdir(join(folder, "docs"), { recursive: true });
  await writeFile(join(folder, "docs", "notes.md"), "# Original notes\n");
  await writeFile(join(folder, "data.bin"), randomBytes(3 * 1024 * 1024));
  await writeFile(join(folder, "README.md"), "# App\n");
}

/** Drops, clashes, the agent's watch, saves, filter, search, and preview in one Folder tab. */
async function transferJourney(
  application: ElectronApplication,
  page: Page,
  options: { label: string; folder: string; desk: string; env: NodeJS.ProcessEnv },
) {
  const { label, folder, desk } = options;
  const region = `${label.split(" · ").at(-1)} folder`;
  await page.getByRole("tab", { name: label, exact: true }).click();
  const tab = page.getByRole("region", { name: region });
  const tree = tab.getByRole("tree", { name: "Folder contents" });
  const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
  if ((await item("docs").getAttribute("aria-expanded")) === "false") await item("docs").click();
  await item("notes.md").waitFor();
  const watch = await startWatch(options.env, folder);
  const dialog = page.getByRole("dialog");
  try {
    // Two files dropped on docs/: one is new, one has a name that already exists.
    await writeFile(join(desk, "spec.pdf"), randomBytes(200_000));
    await writeFile(join(desk, "notes.md"), `# Dropped notes\n\n${MARKER}\n`);
    await dropFiles(page, region, "docs", [join(desk, "spec.pdf"), join(desk, "notes.md")]);
    await dialog.getByText("notes.md already exists in docs").waitFor();
    await dialog.getByRole("button", { name: "Keep both" }).click();
    await expect.poll(() => watch.dropped().length).toBe(1);
    expect(watch.dropped()[0]!.paths).toEqual(["docs/spec.pdf", "docs/notes 2.md"]);
    expect(await hash(join(folder, "docs", "spec.pdf"))).toBe(await hash(join(desk, "spec.pdf")));
    expect(await hash(join(folder, "docs", "notes 2.md"))).toBe(await hash(join(desk, "notes.md")));
    expect(await readFile(join(folder, "docs", "notes.md"), "utf8")).toBe("# Original notes\n");
    expect(await readFile(join(desk, "notes.md"), "utf8")).toContain(MARKER);
    // The tree shows the copies and selects the first one.
    await expect.poll(() => item("spec.pdf").getAttribute("aria-selected")).toBe("true");
    await item("notes 2.md").waitFor();

    // Cancel writes nothing; Replace writes the dropped bytes only after it is chosen.
    await writeFile(join(desk, "notes.md"), "# Replacement\n");
    await dropFiles(page, region, "notes.md", [join(desk, "notes.md")]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await readFile(join(folder, "docs", "notes.md"), "utf8")).toBe("# Original notes\n");
    await dropFiles(page, region, "docs", [join(desk, "notes.md")]);
    await dialog.getByRole("button", { name: "Replace" }).click();
    await expect.poll(() => watch.dropped().length).toBe(2);
    expect(watch.dropped()[1]!.paths).toEqual(["docs/notes.md"]);
    expect(await readFile(join(folder, "docs", "notes.md"), "utf8")).toBe("# Replacement\n");

    // Several clashes ask once with Apply to all; empty space copies into the folder itself.
    await writeFile(join(desk, "README.md"), "# Dropped readme\n");
    await writeFile(join(desk, "new.txt"), "new\n");
    await writeFile(join(desk, "data.bin"), randomBytes(1000));
    await dropFiles(page, region, null, [
      join(desk, "README.md"),
      join(desk, "new.txt"),
      join(desk, "data.bin"),
    ]);
    await expect.poll(() => tab.locator(".folder-tree[data-drop-root]").count()).toBe(0);
    await dialog.getByText("README.md already exists in this folder").waitFor();
    await dialog.getByLabel("Apply to all 2 files with existing names").check();
    await dialog.getByRole("button", { name: "Keep both" }).click();
    await expect.poll(() => watch.dropped().length).toBe(3);
    expect(watch.dropped()[2]!.paths).toEqual(["README 2.md", "new.txt", "data 2.bin"]);
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("# App\n");
    expect(await everything(folder)).not.toContainEqual(expect.stringMatching(/scope-partial/));

    // A dropped file is found by the filter and content search, previews, and saves out.
    await tab.getByLabel("Filter by file name").fill("notes 2");
    await expect.poll(() => tree.getByRole("treeitem").count()).toBe(2);
    await tab.getByLabel("Filter by file name").fill("");
    await tab.getByRole("button", { name: "Search", exact: true }).click();
    await tab.getByLabel("Search file contents").fill(MARKER);
    const results = tab.getByRole("list", { name: "Search results" });
    await expect
      .poll(() => results.locator(".folder-search-place").allTextContents())
      .toEqual(["docs/notes 2.md:3"]);
    await tab.getByRole("button", { name: "Files", exact: true }).click();
    await item("notes 2.md").click();
    await tab
      .getByRole("region", { name: "Preview of notes 2.md" })
      .getByRole("heading", { name: "Dropped notes" })
      .waitFor();
    await saveOut(application, tab, item, folder, desk);
  } finally {
    watch.stop();
  }
}

/** Saves a binary file from its preview with identical bytes; a cancelled save writes nothing. */
async function saveOut(
  application: ElectronApplication,
  tab: ReturnType<Page["getByRole"]>,
  item: (name: string) => ReturnType<Page["getByRole"]>,
  folder: string,
  desk: string,
) {
  const saved = join(desk, "saved", `${Date.now()}.bin`);
  await mkdir(join(desk, "saved"), { recursive: true });
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, saved);
  await item("data.bin").click();
  const preview = tab.getByRole("region", { name: "Preview of data.bin" });
  await preview.getByRole("button", { name: "Save to computer…" }).click();
  await expect
    .poll(() =>
      readFile(saved).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  expect(await hash(saved)).toBe(await hash(join(folder, "data.bin")));
  const before = await everything(join(desk, "saved"));
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
  await preview.getByRole("button", { name: "Save to computer…" }).click();
  await new Promise((done) => setTimeout(done, 500));
  expect(await everything(join(desk, "saved"))).toEqual(before);
}

/** A slow PUT to a hub's write route, so the test can change the folder mid-copy. */
function slowWrite(endpoint: string, headers: Record<string, string>, query: URLSearchParams) {
  const outgoing = httpRequest(`${endpoint}/v1/relay/folders/write?${query}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
  });
  const answer = new Promise<{ status: number; body: string }>((done, fail) => {
    outgoing.on("response", (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () => done({ status: response.statusCode!, body }));
    });
    outgoing.on("error", fail);
  });
  outgoing.write(randomBytes(256 * 1024));
  return {
    answer,
    finish: () => outgoing.end(randomBytes(256 * 1024)),
    abort: () => outgoing.destroy(),
  };
}

/**
 * A hub's write route stays inside the folder when docs/ is swapped for a link mid-copy,
 * refuses to overwrite a name created mid-copy, and leaves no staged file after a cancel.
 */
async function writeRaces(base: string) {
  const hub = await spawnedHub(join(base, "races-hub"));
  try {
    const paired = (await (
      await fetch(`${hub.endpoint}/v1/pair`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${new URL(hub.pairUrl).hash.slice(1)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "test desktop" }),
      })
    ).json()) as { token: string };
    const desktop = { Authorization: `Bearer ${paired.token}` };
    const folder = join(base, "races");
    const outside = join(base, "races-outside");
    await mkdir(join(folder, "docs"), { recursive: true });
    await mkdir(join(folder, ".git"));
    await mkdir(outside);
    await symlink(join(folder, ".git"), join(folder, "gitlink"));
    const root = await realpath(folder);
    const query = (path: string) => new URLSearchParams({ root, path, replace: "0" });

    const swapped = slowWrite(hub.endpoint, desktop, query("docs/race.bin"));
    await new Promise((done) => setTimeout(done, 300));
    await rename(join(folder, "docs"), join(folder, "docs-moved"));
    await symlink(outside, join(folder, "docs"));
    swapped.finish();
    expect((await swapped.answer).status).toBe(403);
    expect(await readdir(outside)).toEqual([]);

    await rm(join(folder, "docs"));
    await rename(join(folder, "docs-moved"), join(folder, "docs"));
    const late = slowWrite(hub.endpoint, desktop, query("docs/late.txt"));
    await new Promise((done) => setTimeout(done, 300));
    await writeFile(join(folder, "docs", "late.txt"), "theirs");
    late.finish();
    const clash = await late.answer;
    expect([clash.status, JSON.parse(clash.body).code]).toEqual([409, "exists"]);
    expect(await readFile(join(folder, "docs", "late.txt"), "utf8")).toBe("theirs");

    const cancelled = slowWrite(hub.endpoint, desktop, query("docs/cancelled.bin"));
    await new Promise((done) => setTimeout(done, 300));
    cancelled.abort();
    await cancelled.answer.catch(() => {});
    for (const path of ["gitlink/x.txt", ".GIT/x.txt"]) {
      const refused = slowWrite(hub.endpoint, desktop, query(path));
      refused.finish();
      expect((await refused.answer).status).toBeGreaterThanOrEqual(403);
    }
    // The publishing token cannot write files.
    const agent = slowWrite(hub.endpoint, { Authorization: `Bearer ${hub.token}` }, query("x"));
    agent.finish();
    expect((await agent.answer).status).toBe(401);
    await expect
      .poll(() => everything(folder))
      .toEqual([".git", "docs", "docs/late.txt", "gitlink"]);
  } finally {
    await hub.stop();
  }
}

test(
  "files dropped on a Folder tab are copied in without overwriting by surprise, announced to the agent, and saved back out, locally and through a hub",
  {
    tags: ["folders-stay-inside", "no-lost-updates", "bad-requests-change-nothing"],
    timeout: 240_000,
  },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const local = join(f.directory, "work", "app");
    const remote = join(f.directory, "work", "remote-app");
    const desk = join(f.directory, "desk");
    await mkdir(desk, { recursive: true });
    await makeFolder(local);
    await makeFolder(remote);
    const localEnv = {
      ...process.env,
      SCOPE_CONNECTION_FILE: f.connectionFile,
      SCOPE_ENDPOINT: undefined,
      SCOPE_TOKEN: undefined,
      SCOPE_TOKEN_FILE: undefined,
    };
    await writeRaces(f.directory);
    const devbox = await spawnedHub(join(f.directory, "devbox"));
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      // The agent selects a file it just wrote; the tab opens with it selected and previewed.
      await writeFile(join(local, "docs", "plan.md"), "# Agent plan\n");
      await f.cli("folder", "select", local, "docs/plan.md", "--title", "App");
      await page.getByRole("tab", { name: "App", exact: true }).click();
      await page
        .getByRole("region", { name: "Preview of plan.md" })
        .getByRole("heading", { name: "Agent plan" })
        .waitFor();
      await transferJourney(application, page, {
        label: "App",
        folder: local,
        desk,
        env: localEnv,
      });

      await page.evaluate((url) => window.scope.pairRemote(url), devbox.pairUrl);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.remotes()))[0]?.connection)
        .toBe("connected");
      await writeFile(join(remote, "docs", "plan.md"), "# Remote plan\n");
      await devbox.cli("folder", "select", remote, "docs/plan.md", "--title", "Remote app");
      await page.getByRole("tab", { name: `${hostname()} · Remote app`, exact: true }).click();
      await page
        .getByRole("region", { name: "Preview of plan.md" })
        .getByRole("heading", { name: "Remote plan" })
        .waitFor();
      await transferJourney(application, page, {
        label: `${hostname()} · Remote app`,
        folder: remote,
        desk,
        env: devbox.env,
      });
    } finally {
      await application.close();
      await devbox.stop();
    }

    // Dropped and saved bytes are never stored by Scope.
    const databases = [
      ...[f.settingsDirectory, join(f.settingsDirectory, "artifacts")].map((directory) =>
        readdir(directory).then((names) => names.map((name) => join(directory, name))),
      ),
      readdir(join(f.directory, "devbox", "data")).then((names) =>
        names.map((name) => join(f.directory, "devbox", "data", name)),
      ),
    ];
    for (const path of (await Promise.all(databases)).flat())
      if (/\.db(-wal)?$/.test(path)) {
        const bytes = await readFile(path);
        for (const text of [MARKER, "new.txt"])
          expect(bytes.includes(text), `${path} contains ${text}`).toBe(false);
      }
    await rm(f.directory, { recursive: true, force: true });
  },
);
