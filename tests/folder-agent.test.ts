import { expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";
import { cliMain, spawnedHub } from "./hub-fixture.ts";

type Receipt = { tabId: string; machine: string; path: string; created: boolean; file?: string };

const failure = (task: Promise<unknown>) =>
  task.then(
    () => "succeeded",
    (error: Error & { stderr?: string }) => error.stderr?.trim() ?? error.message,
  );

const selectedTab = (page: Page) =>
  page.locator('[role="tab"][aria-selected="true"]').allTextContents();

/** Runs `folder watch` and resolves once Scope accepted it. */
async function startWatch(env: NodeJS.ProcessEnv, folder: string) {
  const child = spawn(process.execPath, [cliMain, "folder", "watch", folder], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.once("exit", (code) => done({ code, stdout, stderr })),
  );
  await new Promise<void>((done, fail) => {
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.includes("Watching the Folder tab")) done();
    });
    void exited.then((result) =>
      fail(new Error(`folder watch exited early: ${JSON.stringify(result)}`)),
    );
  });
  return { child, exited };
}

/**
 * Sits between the desktop and a hub so a test can hold back the remote folder's root
 * listing, which the Folder tab reads first.
 */
async function listingProxy(endpoint: string) {
  const held: (() => void)[] = [];
  let holding = false;
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url!, "http://127.0.0.1");
    const root = url.pathname === "/v1/relay/folders/list" && url.searchParams.get("path") === "";
    const upstream = request(
      endpoint + incoming.url,
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        const deliver = () => {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        };
        if (holding && root) held.push(deliver);
        else deliver();
      },
    );
    upstream.on("error", () => outgoing.destroy());
    // A relayed watch answer streams for minutes; pass its headers on at once.
    upstream.flushHeaders();
    incoming.pipe(upstream);
    outgoing.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    held,
    hold: () => (holding = true),
    release: () => {
      holding = false;
      for (const deliver of held.splice(0)) deliver();
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * Pairs a hub with a desktop stand-in that advertises folders but never answers, then
 * starts a watch through it. `result` settles after the hub's forwarding deadline.
 */
async function silentHub(directory: string, folder: string) {
  const hub = await spawnedHub(directory);
  const pairToken = new URL(hub.pairUrl).hash.slice(1);
  const paired = (await (
    await fetch(`${hub.endpoint}/v1/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pairToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "silent desktop" }),
    })
  ).json()) as { token: string };
  const relay = new AbortController();
  const events = await fetch(`${hub.endpoint}/v1/relay/events`, {
    headers: { Authorization: `Bearer ${paired.token}`, "Scope-Relay-Capabilities": "folders" },
    signal: relay.signal,
  });
  const lines: string[] = [];
  let relayOpen = true;
  void (async () => {
    for await (const chunk of events.body!.pipeThrough(new TextDecoderStream()))
      lines.push(...chunk.split("\n").filter(Boolean));
  })()
    .catch(() => {})
    .finally(() => (relayOpen = false));
  const result = (async () => {
    const response = await fetch(
      `${hub.endpoint}/v1/folders/watch?path=${encodeURIComponent(folder)}`,
      { headers: { Authorization: `Bearer ${hub.token}` } },
    );
    const body = (await response.json()) as { error: string };
    const canceled = () => lines.some((line) => JSON.parse(line).type === "cancel");
    for (let wait = 0; wait < 40 && !canceled(); wait++) await delay(50);
    return {
      status: response.status,
      error: body.error,
      canceled: canceled(),
      relayOpen,
    };
  })().finally(async () => {
    relay.abort();
    await hub.stop();
  });
  // Keep an early test failure from leaving this rejection unhandled.
  result.catch(() => {});
  return { result };
}

test(
  "an agent finds its Folder tab, selects a file in it, and watches it until it closes, locally and through a hub",
  {
    tags: ["folders-stay-inside", "tabs-stay-put", "bad-requests-change-nothing"],
    timeout: 240_000,
  },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const work = join(f.directory, "work");
    const app = join(work, "app");
    const other = join(work, "other");
    await mkdir(join(app, "docs", "plans"), { recursive: true });
    await mkdir(other);
    await writeFile(join(app, "docs", "plans", "login.html"), "<h1>Login fix</h1>\n");
    await writeFile(join(app, "docs", "notes.md"), "# Notes\n");
    // Agents often write plans into ignored folders.
    await writeFile(join(app, ".gitignore"), "plans/\n");
    await writeFile(join(work, "secret.txt"), "outside the folder\n");
    const root = await realpath(app);
    const localEnv = {
      ...process.env,
      SCOPE_CONNECTION_FILE: f.connectionFile,
      SCOPE_ENDPOINT: undefined,
      SCOPE_TOKEN: undefined,
      SCOPE_TOKEN_FILE: undefined,
    };
    const folder = async (...args: string[]) =>
      JSON.parse((await f.cli("folder", ...args)).stdout) as Receipt & { open?: boolean };
    const devbox = await spawnedHub(join(f.directory, "devbox"));
    const proxy = await listingProxy(devbox.endpoint);
    const application = await f.launch();
    const watches: Awaited<ReturnType<typeof startWatch>>[] = [];
    try {
      const page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
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
      const tabs = () => page.getByRole("tab").allTextContents();

      // A folder without a tab is not open, and find still succeeds.
      expect(await folder("find", app)).toEqual({ open: false, machine: "local", path: root });

      // Case 1: select opens the tab like `folder open`, without taking selection.
      const selected = await folder("select", app, "docs/plans/login.html", "--title", "Login fix");
      expect(selected).toEqual({
        tabId: selected.tabId,
        machine: "local",
        path: root,
        created: true,
        file: "docs/plans/login.html",
      });
      const folderTab = page.getByRole("tab", { name: "Login fix", exact: true });
      await folderTab.waitFor();
      expect(await tabs()).toEqual(["Notes", "Login fix"]);
      expect(await selectedTab(page)).toEqual(["Notes"]);
      const unread = page.locator(".artifact-tab", { has: folderTab }).locator(".unread-dot");
      expect(await unread.count()).toBe(1);
      expect(await folder("find", `${app}/`)).toEqual({
        open: true,
        tabId: selected.tabId,
        machine: "local",
        path: root,
      });

      // Files outside the folder or missing fail clearly and open nothing.
      expect(await failure(f.cli("folder", "select", app, "../secret.txt"))).toBe(
        "Use a FILE path inside the folder, relative to PATH, such as docs/plan.md.",
      );
      const { endpoint, token } = JSON.parse(await readFile(f.connectionFile, "utf8")) as {
        endpoint: string;
        token: string;
      };
      const command = (base: string, bearer: string, body: unknown) =>
        fetch(`${base}/v1/folders/select`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const outside = await command(endpoint, token, { path: app, file: "../secret.txt" });
      expect(outside.status).toBe(403);
      expect(await outside.json()).toMatchObject({ code: "outside-folder" });
      expect(await failure(f.cli("folder", "select", other, "missing.md"))).toBe(
        "missing.md does not exist.",
      );
      expect(await folder("find", other)).toMatchObject({ open: false });
      expect(await tabs()).toEqual(["Notes", "Login fix"]);

      // Opening the tab shows every folder down to the file expanded and the file selected,
      // with ignored files shown because the file is one.
      const tree = page.getByRole("tree", { name: "Folder contents" });
      const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
      await folderTab.click();
      await item("login.html, ignored").waitFor();
      expect(await item("login.html, ignored").getAttribute("aria-selected")).toBe("true");
      expect(await item("plans, ignored").getAttribute("aria-expanded")).toBe("true");
      expect(await page.getByLabel("Show ignored files").isChecked()).toBe(true);

      // Case 2: an existing tab with docs collapsed is reused and expanded again.
      await item("docs").click();
      await item("login.html, ignored").waitFor({ state: "hidden" });
      await item("notes.md").waitFor({ state: "hidden" });
      await page.getByRole("tab", { name: "Notes", exact: true }).click();
      expect(await folder("select", app, "./docs/notes.md")).toMatchObject({
        tabId: selected.tabId,
        created: false,
        file: "docs/notes.md",
      });
      await unread.waitFor();
      expect(await selectedTab(page)).toEqual(["Notes"]);
      expect(await tabs()).toEqual(["Notes", "Login fix"]);
      await folderTab.click();
      await item("notes.md").waitFor();
      expect(await item("notes.md").getAttribute("aria-selected")).toBe("true");
      expect(await item("docs").getAttribute("aria-expanded")).toBe("true");

      // A local watch ends with `closed` when the person closes the tab, here a bookmark,
      // even while the window still shows an older copy of the tab: main's notice of the
      // agent's newer selection is held back until after the close.
      await page.getByRole("button", { name: "Keep permanently: Login fix", exact: true }).click();
      const stale = await startWatch(localEnv, app);
      watches.push(stale);
      await application.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        const send = contents.send.bind(contents);
        const held: [string, ...unknown[]][] = [];
        contents.send = (channel: string, ...args: unknown[]) => {
          if (channel === "scope:folder-tab-opened") held.push([channel, ...args]);
          else send(channel, ...args);
        };
        Object.assign(globalThis, {
          releaseFolderEvents: () => {
            contents.send = send;
            for (const [channel, ...args] of held) send(channel, ...args);
          },
        });
      });
      await client.folderSelect({ path: app, file: "docs/plans/login.html" });
      await page.getByRole("button", { name: "Close Login fix", exact: true }).click();
      await folderTab.waitFor({ state: "hidden" });
      expect(await stale.exited).toMatchObject({ code: 0, stdout: '{"type":"closed"}\n' });
      expect(await folder("find", app)).toMatchObject({ open: false });
      // Reopening from the drawer opens the tab again and keeps the agent's selection.
      await page.getByRole("button", { name: /^Tabs and Trashcan/ }).click();
      await page.locator(".tab-drawer-select").filter({ hasText: "Login fix" }).click();
      await folderTab.waitFor();
      expect(await folder("find", app)).toMatchObject({ open: true, tabId: selected.tabId });
      await application.evaluate(() =>
        (globalThis as unknown as { releaseFolderEvents: () => void }).releaseFolderEvents(),
      );
      await folderTab.click();
      await expect
        .poll(() => item("login.html, ignored").getAttribute("aria-selected"))
        .toBe("true");

      // A watch also ends when an agent reopens the tab right after the close.
      const local = await startWatch(localEnv, app);
      watches.push(local);
      await page.getByRole("button", { name: "Close Login fix", exact: true }).click();
      await client.folderOpen({ path: app });
      expect(await local.exited).toMatchObject({ code: 0, stdout: '{"type":"closed"}\n' });
      await page.getByRole("button", { name: "Close Login fix", exact: true }).click();
      await expect.poll(async () => (await folder("find", app)).open).toBe(false);
      expect(await failure(f.cli("folder", "watch", app))).toBe(
        "This folder has no open Folder tab. Run irudd-scope folder open first.",
      );

      // A hub whose desktop never answers a watch fails it at the forwarding deadline,
      // cancels it, and keeps the relay. This runs alongside the steps below.
      const silentDesktop = await silentHub(join(f.directory, "silent"), app);

      // Through a hub, a remote agent gets its own tab and the same answers.
      const pairUrl = new URL(devbox.pairUrl);
      pairUrl.searchParams.set("endpoint", proxy.endpoint);
      await page.evaluate((url) => window.scope.pairRemote(url), pairUrl.href);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.remotes()))[0]?.connection)
        .toBe("connected");
      const remote = JSON.parse(
        await devbox.cli("folder", "select", app, "docs/plans/login.html", "--title", "Remote"),
      ) as Receipt;
      expect(remote).toMatchObject({ machine: devbox.id, path: root, created: true });
      expect(remote.tabId).not.toBe(selected.tabId);
      const remoteTab = page.getByRole("tab", { name: `${hostname()} · Remote`, exact: true });
      await remoteTab.waitFor();
      expect(await selectedTab(page)).toEqual(["Notes"]);
      expect(JSON.parse(await devbox.cli("folder", "find", app))).toEqual({
        open: true,
        tabId: remote.tabId,
        machine: devbox.id,
        path: root,
      });
      const remoteOutside = await command(devbox.endpoint, devbox.token, {
        path: app,
        file: "../secret.txt",
      });
      expect(remoteOutside.status).toBe(403);
      expect(await failure(devbox.cli("folder", "select", other, "missing.md"))).toBe(
        "missing.md does not exist.",
      );
      expect(JSON.parse(await devbox.cli("folder", "find", other))).toMatchObject({
        open: false,
      });

      // A file selected while the tab is still reading the folder for the first time
      // appears once that first listing arrives.
      await mkdir(join(app, "src"));
      await writeFile(join(app, "src", "main.ts"), "export {};\n");
      proxy.hold();
      await remoteTab.click();
      await expect.poll(() => proxy.held.length).toBeGreaterThan(0);
      expect(JSON.parse(await devbox.cli("folder", "select", app, "src/main.ts"))).toMatchObject({
        tabId: remote.tabId,
        created: false,
      });
      await delay(300);
      proxy.release();
      await expect.poll(() => item("main.ts").getAttribute("aria-selected")).toBe("true");

      // A hub keeps at most 16 watches, even when many arrive at once, and open watches
      // leave all 16 publication slots free.
      const remoteWatch = await startWatch(devbox.env, app);
      watches.push(remoteWatch);
      const extra = new AbortController();
      const statuses = await Promise.all(
        Array.from({ length: 24 }, () =>
          fetch(`${devbox.endpoint}/v1/folders/watch?path=${encodeURIComponent(app)}`, {
            headers: { Authorization: `Bearer ${devbox.token}` },
            signal: extra.signal,
          }).then((response) => response.status),
        ),
      );
      expect(statuses.filter((status) => status === 200)).toHaveLength(15);
      expect(statuses.filter((status) => status === 503)).toHaveLength(9);
      const published = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          devbox.cli("text", `Concurrent ${index}`, "--title", `Concurrent ${index}`),
        ),
      );
      expect(published).toHaveLength(16);
      await page.getByRole("tab", { name: "Concurrent 15", exact: true }).waitFor();
      expect(remoteWatch.child.exitCode).toBeNull();
      expect((await page.evaluate(() => window.scope.remotes()))[0]?.connection).toBe("connected");
      extra.abort();
      // The new tabs push the Folder tab into the drawer, so close it the way the strip does.
      await page.evaluate((id) => window.scope.closeTab(id), remote.tabId);
      expect(await remoteWatch.exited).toMatchObject({ code: 0, stdout: '{"type":"closed"}\n' });
      expect(JSON.parse(await devbox.cli("folder", "find", app))).toMatchObject({ open: false });

      // A watch fails clearly when the desktop goes away.
      await devbox.cli("folder", "open", app);
      const dropped = await startWatch(devbox.env, app);
      watches.push(dropped);
      await application.close();
      expect(await dropped.exited).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Scope disconnected before the Folder tab closed."),
      });
      expect(await failure(devbox.cli("folder", "watch", app))).toMatch(
        /^Scope desktop is not connected/,
      );
      expect(await silentDesktop.result).toEqual({
        status: 503,
        error: "Scope desktop did not start the folder watch in time. Retry the command.",
        canceled: true,
        relayOpen: true,
      });
    } finally {
      for (const { child } of watches) child.kill();
      await application.close();
      await devbox.stop();
      proxy.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
