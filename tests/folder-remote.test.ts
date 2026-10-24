import { expect, test } from "vite-plus/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { chmod, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { desktopFixture } from "./desktop-fixture.ts";

const exec = promisify(execFile);
const hubMain = resolve("apps/hub/dist/main.mjs");
const cliMain = resolve("packages/cli/dist/main.mjs");

type Receipt = { tabId: string; machine: string; path: string; created: boolean };

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/** A hub from the built executable, as a remote installs it. */
async function spawnedHub(directory: string, extra: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    ...extra,
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
  const info = JSON.parse((await exec(process.execPath, [hubMain, "info"], { env })).stdout);
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(process.execPath, [hubMain, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done, fail) => {
      child!.stdout!.on("data", (data: Buffer) => {
        if (data.toString().includes("Scope hub listening")) done();
      });
      child!.once("exit", () => fail(new Error("The hub exited during startup.")));
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((done) => child!.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  };
  const cli = async (...args: string[]) =>
    (await exec(process.execPath, [cliMain, ...args], { env, timeout: 15_000 })).stdout;
  const token = JSON.parse(await readFile(env.SCOPE_CONNECTION_FILE, "utf8")).token as string;
  await start();
  const pairUrl = /irudd-scope:\/\/pair\S+/.exec(await cli("pair"))![0];
  return { id: info.id as string, endpoint, token, pairUrl, start, stop, cli };
}

type Hub = Awaited<ReturnType<typeof spawnedHub>>;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Pairs the test itself as a desktop, returning the desktop connection credential. */
async function pairAsDesktop(hub: Hub) {
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
  return { Authorization: `Bearer ${paired.token}` };
}

async function lines(response: Response, into: string[]) {
  let pending = "";
  for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop()!;
    into.push(...parts.filter(Boolean));
  }
}

/** Reads a folder's change feed from a hub while `during` runs, and returns its events. */
async function feed(
  hub: Hub,
  desktop: Record<string, string>,
  root: string,
  during: () => Promise<void>,
) {
  const controller = new AbortController();
  const received: string[] = [];
  const response = await fetch(
    `${hub.endpoint}/v1/relay/folders/events?${new URLSearchParams({ root })}`,
    { headers: desktop, signal: controller.signal },
  );
  const reading = lines(response, received).catch(() => {});
  await wait(500);
  await during();
  controller.abort();
  await reading;
  return received.map(
    (line) =>
      JSON.parse(line) as {
        type: string;
        overflow?: boolean;
        live?: boolean;
        changes?: { type: string; path: string }[];
        ignoreRulesChanged?: string[];
      },
  );
}

const changed = (events: Awaited<ReturnType<typeof feed>>) =>
  events.flatMap((event) => (event.changes ?? []).map((change) => `${change.type} ${change.path}`));

/**
 * File routes stay inside the folder while it changes underneath them, and the change feed
 * keeps reporting after directories are replaced, after an overflow, and during activity in
 * ignored folders.
 */
async function fileRouteChecks(hub: Hub, desktop: Record<string, string>, base: string) {
  const root = join(base, "routes");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await mkdir(join(root, "pipes"), { recursive: true });
  await mkdir(join(base, "routes-outside"), { recursive: true });
  await writeFile(join(root, "sub", "file.txt"), "inside");
  await writeFile(join(base, "routes-outside", "file.txt"), "OUTSIDE-SENTINEL");
  await writeFile(join(base, "routes-outside", ".gitignore"), "visible.txt\n");
  await writeFile(join(root, "visible.txt"), "visible");
  await writeFile(join(root, ".git", "internal-marker"), "internal");
  await symlink(join(base, "routes-outside", ".gitignore"), join(root, ".gitignore"));
  await symlink(join(root, ".git", "internal-marker"), join(root, "git-marker"));
  // Named pipes block a plain open until something writes to them.
  await exec("mkfifo", [join(root, "pipes", "pipe.txt"), join(root, "pipes", ".gitignore")]);
  const real = await realpath(root);
  const route = (name: string, query: Record<string, string>) =>
    fetch(
      `${hub.endpoint}/v1/relay/folders/${name}?${new URLSearchParams({ root: real, ...query })}`,
      {
        headers: desktop,
      },
    );

  // Ignore rules behind a link out of the folder are not read, and .git is never listed.
  const listing = (await (await route("list", { path: "", showIgnored: "0" })).json()) as {
    entries: { name: string }[];
  };
  expect(listing.entries.map((entry) => entry.name)).toContain("visible.txt");
  const git = await route("list", { path: ".git", showIgnored: "0" });
  expect(git.status).toBe(404);
  expect(await git.text()).not.toContain("internal-marker");
  // A link into .git is listed as leading outside, without the size of what is there.
  expect(listing.entries.find((entry) => entry.name === "git-marker")).toEqual({
    name: "git-marker",
    path: "git-marker",
    kind: "symlink",
    link: "outside",
    modifiedAt: expect.any(Number),
    ignored: false,
  });

  // Reads of a named pipe fail at once and leave no file system threads waiting, and a pipe
  // named .gitignore does not hold up a listing.
  const pipes = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(
        `${hub.endpoint}/v1/relay/folders/read?${new URLSearchParams({ root: real, path: "pipes/pipe.txt", start: "0" })}`,
        { headers: desktop, signal: AbortSignal.timeout(5000) },
      ).then(async (response) => ({ status: response.status, ...(await response.json()) })),
    ),
  );
  expect(pipes.map(({ status, code }) => `${status} ${code}`)).toEqual(
    Array.from({ length: 8 }, () => "400 not-a-directory"),
  );
  const piped = await fetch(
    `${hub.endpoint}/v1/relay/folders/list?${new URLSearchParams({ root: real, path: "pipes", showIgnored: "0" })}`,
    { headers: desktop, signal: AbortSignal.timeout(5000) },
  );
  expect(await piped.json()).toMatchObject({
    entries: [
      { name: ".gitignore", kind: "other" },
      { name: "pipe.txt", kind: "other" },
    ],
  });

  // A file system error is `failed`, never `unsupported`, which asks for an update.
  if (process.getuid?.() !== 0) {
    await mkdir(join(root, "locked"));
    await chmod(join(root, "locked"), 0);
    const locked = await route("list", { path: "locked", showIgnored: "0" });
    expect(locked.status).toBe(500);
    expect(await locked.json()).toMatchObject({ code: "failed" });
    await chmod(join(root, "locked"), 0o755);
  }
  await rm(join(root, ".gitignore"));
  await writeFile(join(root, ".gitignore"), "node_modules/\n");

  // Swapping a folder for a link out of the root never lets a read through.
  let swapping = true;
  const swaps = (async () => {
    while (swapping) {
      await wait(2);
      await rename(join(root, "sub"), join(root, "parked"));
      await symlink(join(base, "routes-outside"), join(root, "sub"));
      await rm(join(root, "sub"));
      await rename(join(root, "parked"), join(root, "sub"));
    }
  })();
  const bodies: string[] = [];
  for (let batch = 0; batch < 40; batch++)
    bodies.push(
      ...(await Promise.all(
        Array.from({ length: 24 }, async () =>
          (await route("read", { path: "sub/file.txt", start: "0" })).text(),
        ),
      )),
    );
  swapping = false;
  await swaps;
  expect(bodies.filter((body) => body.includes("OUTSIDE-SENTINEL"))).toEqual([]);
  expect(bodies).toContain("inside");

  // Activity in an ignored folder is dropped before a batch is counted.
  const ignored = await feed(hub, desktop, real, async () => {
    await Promise.all(
      Array.from({ length: 1600 }, (_, index) =>
        writeFile(join(root, "node_modules", `package-${index}.js`), "x"),
      ),
    );
    await wait(600);
    await writeFile(join(root, "after-install.txt"), "x");
    await wait(1200);
  });
  expect(ignored.some((event) => event.overflow)).toBe(false);
  expect(changed(ignored)).toContain("created after-install.txt");

  // A replaced folder and a folder made during an overflow keep reporting their changes.
  const recovered = await feed(hub, desktop, real, async () => {
    await rm(join(root, "sub"), { recursive: true });
    await wait(400);
    await mkdir(join(root, "sub"));
    await wait(600);
    await writeFile(join(root, "sub", "again.txt"), "x");
    await wait(600);
    await Promise.all(
      Array.from({ length: 1200 }, (_, index) => writeFile(join(root, `burst-${index}.txt`), "x")),
    );
    await mkdir(join(root, "burst"));
    await wait(1200);
    await writeFile(join(root, "burst", "later.txt"), "x");
    await wait(1200);
  });
  expect(changed(recovered)).toEqual(
    expect.arrayContaining(["created sub/again.txt", "created burst/later.txt"]),
  );
  expect(recovered.some((event) => event.overflow)).toBe(true);

  // Changed ignore rules, including .git/info/exclude, are reported so readers reload below
  // them, and a folder that is no longer ignored is watched from then on.
  const rules = await feed(hub, desktop, real, async () => {
    await writeFile(join(root, ".git", "info", "exclude"), "*.log\n");
    await wait(600);
    await writeFile(join(root, "sub", ".gitignore"), "*.tmp\n");
    await wait(600);
    await writeFile(join(root, ".gitignore"), "");
    await wait(800);
    await writeFile(join(root, "node_modules", "unignored.js"), "x");
    await wait(1200);
    // Watches name events on a watched folder itself by its own name, as if it were a child.
    await chmod(root, 0o700);
    await chmod(join(root, "sub"), 0o700);
    await wait(600);
    await writeFile(join(root, "routes"), "a child named like the folder");
    await wait(600);
    await rm(join(root, "routes"));
    await wait(1200);
  });
  const ruleChanges = rules.flatMap((event) => event.ignoreRulesChanged ?? []);
  const sub = ruleChanges.indexOf("sub");
  expect(ruleChanges.slice(0, Math.max(sub, 0))).toContain("");
  expect(ruleChanges.slice(sub + 1)).toContain("");
  expect(changed(rules)).toContain("created node_modules/unignored.js");
  expect(changed(rules).filter((change) => change.includes(".git/"))).toEqual([]);
  expect(changed(rules).filter((change) => / (routes|sub\/sub)$/.test(change))).toEqual([
    "created routes",
    "deleted routes",
  ]);
}

/** Without file watches, the feed says so and still finds added files and edited contents. */
async function pollingChecks(hub: Hub, base: string) {
  const desktop = await pairAsDesktop(hub);
  const root = join(base, "polled");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "notes.txt"), "first");
  const events = await feed(hub, desktop, await realpath(root), async () => {
    await writeFile(join(root, "notes.txt"), "second, longer");
    await writeFile(join(root, "added.txt"), "x");
    await wait(4500);
  });
  expect(events[0]).toMatchObject({ type: "status", exists: true, live: false });
  expect(changed(events)).toEqual(
    expect.arrayContaining(["changed notes.txt", "created added.txt"]),
  );
}

/** Running out of watches while catching up after lost events switches the feed to polling. */
async function exhaustionChecks(hub: Hub, base: string) {
  const desktop = await pairAsDesktop(hub);
  const root = join(base, "exhausted");
  await mkdir(root, { recursive: true });
  // A folder that already has files moves in, so its contents exist before polling starts.
  const staged = join(base, "staged-burst");
  await mkdir(staged, { recursive: true });
  await writeFile(join(staged, "early.txt"), "x");
  const events = await feed(hub, desktop, await realpath(root), async () => {
    await rename(staged, join(root, "burst"));
    await wait(1000);
    await writeFile(join(root, "burst", "later.txt"), "x");
    await wait(4500);
  });
  expect(changed(events)).toContain("created burst/later.txt");
  // Only Linux watches each folder; macOS and Windows watch the whole folder at once.
  if (process.platform === "linux") {
    const polling = events.findIndex((event) => event.type === "status" && event.live === false);
    expect(polling).toBeGreaterThanOrEqual(0);
    // Readers are told to reload, so the moved folder and its early file are listed.
    expect(events.slice(polling).some((event) => event.overflow)).toBe(true);
  }
  const listing = await fetch(
    `${hub.endpoint}/v1/relay/folders/list?${new URLSearchParams({ root: await realpath(root), path: "burst", showIgnored: "0" })}`,
    { headers: desktop },
  ).then((response) => response.json() as Promise<{ entries: { name: string }[] }>);
  expect(listing.entries.map((entry) => entry.name)).toEqual(["early.txt", "later.txt"]);
}

/** Folder commands waiting for their bodies hold relay slots, so at most 16 reach the desktop. */
async function admissionChecks(hub: Hub, desktop: Record<string, string>, folder: string) {
  const relay = new AbortController();
  const events: string[] = [];
  const response = await fetch(`${hub.endpoint}/v1/relay/events`, {
    headers: { ...desktop, "Scope-Relay-Capabilities": "folders" },
    signal: relay.signal,
  });
  const reading = lines(response, events).catch(() => {});
  const calls = Array.from({ length: 24 }, () => {
    const call = httpRequest(`${hub.endpoint}/v1/folders/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hub.token}`,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    });
    const status = new Promise<number>((done) => {
      call.on("response", (reply) => {
        reply.resume();
        done(reply.statusCode ?? 0);
      });
      call.on("error", () => done(0));
    });
    call.flushHeaders();
    return { call, status };
  });
  await wait(300);
  for (const { call } of calls) call.end(JSON.stringify({ path: folder }));
  await wait(1000);
  expect(events.filter((line) => line.includes('"request"')).length).toBe(16);
  relay.abort();
  await reading;
  const statuses = await Promise.all(calls.map(({ status }) => status));
  expect(statuses.filter((status) => status === 503).length).toBe(24);
}

const failure = (task: Promise<unknown>) =>
  task.then(
    () => "succeeded",
    (error: Error & { stderr?: string }) => error.stderr?.trim() ?? error.message,
  );

test(
  "a remote agent opens its folder through the hub, and only the paired desktop reads its files",
  {
    tags: ["folders-stay-inside", "secrets-stay-secret", "bad-requests-change-nothing"],
    timeout: 180_000,
  },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const folder = join(f.directory, "work", "flaky");
    await mkdir(join(folder, "src"), { recursive: true });
    await mkdir(join(f.directory, "outside"));
    await writeFile(join(folder, "src", "flaky.test.ts"), "export const attempts = 3;\n");
    await writeFile(join(f.directory, "outside", "secret.txt"), "outside the folder\n");
    await symlink(join(f.directory, "outside"), join(folder, "link-out"));
    for (let index = 0; index < 40; index++) {
      const directory = join(folder, "many", `d${String(index).padStart(2, "0")}`);
      await mkdir(directory, { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, file) => writeFile(join(directory, `f${file}.txt`), "x")),
      );
    }
    const devbox = await spawnedHub(join(f.directory, "devbox"));
    const older = await spawnedHub(join(f.directory, "older-desktop"));
    const exhausted = await spawnedHub(join(f.directory, "exhausted-hub"), {
      NODE_OPTIONS: `--import=${resolve("tests/fixtures/folder/watches-run-out-on-burst.mjs")}`,
    });
    const polled = await spawnedHub(join(f.directory, "polled-hub"), {
      NODE_OPTIONS: `--import=${resolve("tests/fixtures/folder/no-file-watches.mjs")}`,
    });
    const application = await f.launch();
    const relay = new AbortController();
    try {
      const page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      await page.evaluate((url) => window.scope.pairRemote(url), devbox.pairUrl);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.remotes()))[0]?.connection)
        .toBe("connected");

      // The remote agent's command goes through its hub and is attributed to that remote.
      const receipt = JSON.parse(
        await devbox.cli("folder", "open", folder, "--title", "Flaky test"),
      ) as Receipt;
      expect(receipt).toEqual({
        tabId: receipt.tabId,
        machine: devbox.id,
        path: await realpath(folder),
        created: true,
      });
      const label = `${hostname()} · Flaky test`;
      const remoteTab = page.getByRole("tab", { name: label, exact: true });
      await remoteTab.waitFor();
      expect(await remoteTab.getAttribute("title")).toContain(await realpath(folder));
      const again = JSON.parse(await devbox.cli("folder", "open", `${folder}/`)) as Receipt;
      expect(again).toMatchObject({ tabId: receipt.tabId, created: false });
      const claimed = await fetch(`${devbox.endpoint}/v1/folders/open`, {
        method: "POST",
        headers: { Authorization: `Bearer ${devbox.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: folder, machine: "local" }),
      }).then((response) => response.json());
      expect(claimed).toMatchObject({ tabId: receipt.tabId, machine: devbox.id });
      const local = JSON.parse((await f.cli("folder", "open", folder)).stdout) as Receipt;
      expect(local).toMatchObject({ machine: "local", created: true });
      expect(local.tabId).not.toBe(receipt.tabId);

      await remoteTab.click();
      const tree = page.getByRole("tree", { name: "Folder contents" });
      const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
      await item("src").click();
      await item("flaky.test.ts").waitFor();
      await item("link-out, link outside this folder").waitFor();
      await writeFile(join(folder, "src", "retry.ts"), "export {};\n");
      await item("retry.ts").waitFor();
      // Expand 40 folders of 100 files each, last first, with the keyboard.
      await item("many").click();
      await item("d00").waitFor();
      await tree.focus();
      const focused = tree.locator("[data-focused]");
      for (let index = 0; index < 40; index++) {
        await page.keyboard.press("ArrowDown");
        await expect
          .poll(() => focused.getAttribute("aria-label"))
          .toBe(`d${String(index).padStart(2, "0")}`);
      }
      for (let index = 39; index >= 0; index--) {
        const name = `d${String(index).padStart(2, "0")}`;
        await expect.poll(() => focused.getAttribute("aria-label")).toBe(name);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => focused.getAttribute("aria-expanded")).toBe("true");
        await page.keyboard.press("ArrowUp");
      }
      const treeHeight = () =>
        tree.evaluate((element) => (element.firstElementChild as HTMLElement).offsetHeight);
      const placeholders = () => tree.locator("[data-placeholder]").count();
      await expect.poll(treeHeight, { timeout: 20_000 }).toBeGreaterThanOrEqual(4041 * 26);
      await expect.poll(placeholders).toBe(0);
      const expandedHeight = await treeHeight();

      // Change feeds for many open remote folders leave room for listings.
      const extras: string[] = [];
      for (let index = 0; index < 33; index++) {
        const extra = join(f.directory, "extras", `e${index}`);
        await mkdir(extra, { recursive: true });
        extras.push(
          (
            (await (
              await fetch(`${devbox.endpoint}/v1/folders/open`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${devbox.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ path: extra }),
              })
            ).json()) as Receipt
          ).tabId,
        );
      }
      await page.evaluate(
        (ids) => Promise.all(ids.map((id) => window.scope.watchFolder(id))),
        extras,
      );
      await wait(1000);
      expect(
        await page.evaluate(
          (tabId) => window.scope.folderList({ tabId, path: "", showIgnored: false }),
          receipt.tabId,
        ),
      ).toMatchObject({ status: "ok" });
      await page.evaluate(
        (ids) => Promise.all(ids.map((id) => window.scope.unwatchFolder(id))),
        extras,
      );

      // File routes refuse the hub's publishing token, a wrong token, and no token.
      const list = `${devbox.endpoint}/v1/relay/folders/list?${new URLSearchParams({ root: await realpath(folder), path: "", showIgnored: "0" })}`;
      for (const authorization of [undefined, `Bearer ${devbox.token}`, "Bearer wrong-token"]) {
        const response = await fetch(list, authorization ? { headers: { authorization } } : {});
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("src");
      }

      // A hub paired with a desktop that did not advertise folders never relays folder commands.
      const desktop = await pairAsDesktop(older);
      const events = await fetch(`${older.endpoint}/v1/relay/events`, {
        headers: desktop,
        signal: relay.signal,
      });
      const lines: string[] = [];
      void (async () => {
        for await (const chunk of events.body!.pipeThrough(new TextDecoderStream()))
          lines.push(...chunk.split("\n").filter(Boolean));
      })().catch(() => {});
      expect(await failure(older.cli("folder", "open", folder))).toBe(
        "Update Scope on the paired desktop to share folders.",
      );
      expect(lines.some((line) => line.includes('"request"'))).toBe(false);

      // With the desktop credential, the hub stays inside the folder and reads exact byte ranges.
      const root = await realpath(folder);
      const route = (path: string, query: Record<string, string>) =>
        fetch(
          `${older.endpoint}/v1/relay/folders/${path}?${new URLSearchParams({ root, ...query })}`,
          {
            headers: desktop,
          },
        );
      expect(await (await route("list", { path: "", showIgnored: "0" })).json()).toMatchObject({
        entries: [{ name: "many" }, { name: "src" }, { name: "link-out", link: "outside" }],
      });
      for (const path of ["..", "../outside", "link-out", "/etc", "src/../.."]) {
        const response = await route("list", { path, showIgnored: "0" });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "outside-folder" });
      }
      for (const path of ["../outside/secret.txt", "link-out/secret.txt"])
        expect((await route("read", { path, start: "0" })).status).toBe(403);
      const bytes = await readFile(join(folder, "src", "flaky.test.ts"));
      const range = await route("read", { path: "src/flaky.test.ts", start: "7", end: "19" });
      expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(7, 19));
      expect(range.headers.get("scope-folder-file-size")).toBe(String(bytes.length));
      await fileRouteChecks(older, desktop, f.directory);
      // A file system error on the remote shows as an error, not as a request to update.
      if (process.getuid?.() !== 0) {
        const locked = join(folder, "locked");
        await mkdir(locked);
        await chmod(locked, 0);
        expect(
          await page.evaluate(
            (tabId) => window.scope.folderList({ tabId, path: "locked", showIgnored: false }),
            receipt.tabId,
          ),
        ).toMatchObject({ status: "error" });
        await chmod(locked, 0o755);
        await rm(locked, { recursive: true });
      }
      relay.abort();
      await expect
        .poll(() => failure(older.cli("folder", "open", folder)))
        .toMatch(/^Scope desktop is not connected/);
      await admissionChecks(older, desktop, folder);
      await pollingChecks(polled, f.directory);
      await exhaustionChecks(exhausted, f.directory);

      // A hub without folder routes answers 404, which the CLI explains as an update.
      const stub = createServer((_request, response) => {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Artifact endpoint not found." }));
      });
      await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
      const stubFile = join(f.directory, "old-hub.json");
      await writeFile(
        stubFile,
        JSON.stringify({
          version: 1,
          endpoint: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
          token: "a".repeat(32),
        }),
      );
      const oldHub = await failure(
        exec(process.execPath, [cliMain, "folder", "open", folder], {
          env: { ...process.env, SCOPE_CONNECTION_FILE: stubFile },
        }),
      );
      stub.close();
      expect(oldHub).toBe(`Update Scope on ${hostname().split(".")[0]} to share folders.`);

      // Offline remotes show no cached files and come back by themselves.
      await devbox.stop();
      await page.getByText(`${hostname()} is offline`).waitFor();
      expect(await tree.count()).toBe(0);
      await devbox.start();
      // Every expanded folder comes back; none is shown empty because of request limits.
      await expect.poll(treeHeight, { timeout: 30_000 }).toBe(expandedHeight);
      await expect.poll(placeholders).toBe(0);
      await devbox.cli("text", "Published through the hub", "--title", "Hub note");
      await page.getByRole("tab", { name: "Hub note", exact: true }).waitFor();
    } finally {
      relay.abort();
      await application.close();
      await devbox.stop();
      await older.stop();
      await polled.stop();
      await exhausted.stop();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
