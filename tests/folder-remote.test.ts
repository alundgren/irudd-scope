import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { desktopFixture } from "./desktop-fixture.ts";
import { cliMain, spawnedHub } from "./hub-fixture.ts";

const exec = promisify(execFile);

type Receipt = { tabId: string; machine: string; path: string; created: boolean };

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
    const devbox = await spawnedHub(join(f.directory, "devbox"));
    const older = await spawnedHub(join(f.directory, "older-desktop"));
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

      // File routes refuse the hub's publishing token, a wrong token, and no token.
      const list = `${devbox.endpoint}/v1/relay/folders/list?${new URLSearchParams({ root: await realpath(folder), path: "", showIgnored: "0" })}`;
      for (const authorization of [undefined, `Bearer ${devbox.token}`, "Bearer wrong-token"]) {
        const response = await fetch(list, authorization ? { headers: { authorization } } : {});
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("src");
      }

      // A hub paired with a desktop that did not advertise folders never relays folder commands.
      const pairToken = new URL(older.pairUrl).hash.slice(1);
      const paired = (await (
        await fetch(`${older.endpoint}/v1/pair`, {
          method: "POST",
          headers: { Authorization: `Bearer ${pairToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "older desktop" }),
        })
      ).json()) as { token: string };
      const desktop = { Authorization: `Bearer ${paired.token}` };
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
        entries: [{ name: "src" }, { name: "link-out", link: "outside" }],
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
      relay.abort();
      await expect
        .poll(() => failure(older.cli("folder", "open", folder)))
        .toMatch(/^Scope desktop is not connected/);

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
      await item("retry.ts").waitFor({ timeout: 30_000 });
      await devbox.cli("text", "Published through the hub", "--title", "Hub note");
      await page.getByRole("tab", { name: "Hub note", exact: true }).waitFor();
    } finally {
      relay.abort();
      await application.close();
      await devbox.stop();
      await older.stop();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
