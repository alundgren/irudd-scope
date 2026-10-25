import { guestNetworkFixture } from "./guest-network-fixture.ts";
import { guestFolderRecoveryChecks } from "./guest-folder-recovery-checks.ts";
import { createHash } from "node:crypto";
import { folderNetwork } from "./guest-folder-network.ts";
import { folderCommand } from "./folder-operation-checks.ts";
import { expect } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { spawnedHub } from "./hub-fixture.ts";
import { syntheticCli } from "./synthetic-cli.ts";
import { guestCli } from "./guest-cli.ts";
import type { Page } from "@playwright/test";

async function prepare(page: Page, tabId: string, paths: string[]) {
  await page.evaluate(() => {
    if (document.querySelector("#folder-upload-input")) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "folder-upload-input";
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator("#folder-upload-input").setInputFiles(paths);
  return page.evaluate(
    (tabId) =>
      window.scope.prepareFolderDrop({
        tabId,
        target: "",
        files: [...(document.querySelector("#folder-upload-input") as HTMLInputElement).files!],
      }),
    tabId,
  );
}

/** Reciprocal native folders through actual desktop sessions and each owner's paired hub. */
export async function guestFolderChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-folders-"));
  const routes = join(directory, "routes.json");
  await writeFile(routes, "{}");
  await syntheticCli(directory, "tailcat", guestCli);
  const network = await guestNetworkFixture(directory);
  const env = {
    ...network.env,
    SCOPE_GUEST_FIXTURE_EVENTS: join(directory, "events.jsonl"),
    SCOPE_GUEST_FIXTURE_ROUTES: routes,
  };
  const a = await desktopFixture({
    hideInitialPrompts: true,
    entry: network.entry,
    env: { ...env, SCOPE_GUEST_TEST_ADDRESS: "100.64.0.1" },
  });
  const b = await desktopFixture({
    hideInitialPrompts: true,
    entry: network.entry,
    env: { ...env, SCOPE_GUEST_TEST_ADDRESS: "100.64.0.2" },
  });
  const ha = await spawnedHub(join(directory, "hub-a"));
  const hb = await spawnedHub(join(directory, "hub-b"));
  const hubProxy = await folderNetwork();
  hubProxy.target(Number(new URL(ha.endpoint).port));
  const peerProxy = await folderNetwork();
  let left = await a.launch(),
    right = await b.launch();
  let pageA = await left.firstWindow(),
    pageB = await right.firstWindow();
  const rootA = join(directory, "files-a"),
    rootB = join(directory, "files-b");
  for (const root of [rootA, rootB]) {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "docs", "notes.md"), "# Remote notes\nsearchable example\n");
    await writeFile(join(root, ".git", "config"), "hidden");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "ignored");
    await symlink(directory, join(root, "outside"));
  }
  async function pair() {
    for (const page of [pageA, pageB]) {
      for (const peer of (await page.evaluate(() => window.scope.transferDevices())).peers)
        await page.evaluate((id) => window.scope.forgetScope(id), peer.id);
    }
    const invitation = await pageA.evaluate(() => window.scope.createPairing("Owner laptop"));
    await pageA.evaluate((id) => window.scope.copyPairingSecret(id), invitation.id);
    const secret = await left.evaluate(({ clipboard }) => clipboard.readText());
    await pageB.evaluate((input) => window.scope.pairScope(input), {
      url: invitation.url,
      secret,
      name: "Guest laptop",
    });
    const peer = (await pageA.evaluate(() => window.scope.transferDevices())).peers.at(-1)!;
    for (const page of [pageA, pageB])
      await page.evaluate((id) => window.scope.setGuestAccess(id, true), peer.id);
    await pageA.evaluate((id) => window.scope.copyGuestLink(id), peer.id);
    const link = await left.evaluate(({ clipboard }) => clipboard.readText());
    const endpoint = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString()).endpoint;
    peerProxy.target(endpoint.port);
    await writeFile(routes, JSON.stringify({ [endpoint.port]: peerProxy.port }));
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), link);
    await pageB.evaluate((id) => window.scope.connectGuestLink(id), peer.id);
    for (const page of [pageA, pageB])
      await expect
        .poll(
          () =>
            page.evaluate(() => window.scope.guestCatalog()).then((view) => view.available.length),
          { timeout: 25_000 },
        )
        .toBe(page === pageB ? 3 : 2);
    return peer.id;
  }
  const guest = async (page: Page, title: string) =>
    (await page.evaluate(() => window.scope.guestCatalog())).records.find(
      (record) => record.tab.title === title,
    )!;
  const select = async (page: Page, id: string) => {
    const tab = page.locator(`#tab-${id}`);
    if (await tab.count()) await tab.click();
    else {
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      const record = (await page.evaluate(() => window.scope.guestCatalog())).records.find(
        (record) => record.tab.id === id,
      )!;
      await page.getByRole("button", { name: record.tab.title + " guest", exact: true }).click();
    }
  };
  const capture = async (name: string) => {
    if (!process.env.SCOPE_REVIEW_DIR) return;
    await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
    await pageB.screenshot({
      path: join(process.env.SCOPE_REVIEW_DIR, name),
      animations: "disabled",
    });
  };
  try {
    await pageA.evaluate((url) => window.scope.pairRemote(url), hubProxy.pairUrl(ha.pairUrl));
    await pageB.evaluate((url) => window.scope.pairRemote(url), hb.pairUrl);
    for (const page of [pageA, pageB])
      await expect
        .poll(() =>
          page.evaluate(() => window.scope.remotes()).then((remotes) => remotes[0]?.connection),
        )
        .toBe("connected");
    await ha.cli(
      "folder",
      "open",
      rootA,
      "--title",
      "Owner remote folder with a long project title",
    );
    await hb.cli("folder", "open", rootB, "--title", "Guest remote folder");
    await (await a.connect()).folderOpen({ path: rootA, title: "Owner local folder" });
    await (await b.connect()).folderOpen({ path: rootB, title: "Guest local folder" });
    await (
      await a.connect()
    ).publish(
      "owner-note",
      {
        title: "Owner note",
        kind: "text",
        mediaType: "text/plain",
        fileName: "note.txt",
        expectedRevision: 0,
      },
      Buffer.from("Owner stays available"),
    );
    await pair();
    for (const [page, app, title, root] of [
      [pageB, right, "Owner remote folder with a long project title", rootA],
      [pageA, left, "Guest remote folder", rootB],
    ] as const) {
      const record = await guest(page, title);
      const id = record.tab.id;
      expect(JSON.stringify(record)).not.toContain(root);
      await select(page, id);
      await page.locator(`#pane-${id}`).getByRole("tree").waitFor();
      const listing = await page.evaluate(
        (tabId) => window.scope.folderList({ tabId, path: "", showIgnored: false }),
        id,
      );
      expect(listing.status).toBe("ok");
      if (listing.status === "ok")
        expect(listing.listing.entries.map((entry) => entry.name)).not.toContain(".git");
      const ignored = await page.evaluate(
        (tabId) => window.scope.folderList({ tabId, path: "", showIgnored: true }),
        id,
      );
      if (ignored.status === "ok")
        expect(ignored.listing.entries.map((entry) => entry.name)).toContain("ignored.txt");
      const search = await page.evaluate(
        (tabId) => window.scope.folderSearch({ tabId, query: "searchable", showIgnored: false }),
        id,
      );
      expect(search.status).toBe("ok");
      if (search.status === "ok") expect(search.matches[0]?.path).toBe("docs/notes.md");
      const read = await page.evaluate(
        (tabId) =>
          window.scope
            .folderRead({ tabId, path: "docs/notes.md", start: 0, end: 1024 })
            .then((file) => new TextDecoder().decode(file.bytes)),
        id,
      );
      expect(read).toContain("searchable");
      for (const path of ["../events.jsonl", ".git/config", "outside/events.jsonl"])
        await expect(
          page.evaluate(
            ({ tabId, path }) => window.scope.folderRead({ tabId, path, start: 0, end: 100 }),
            { tabId: id, path },
          ),
        ).rejects.toThrow();
      const folderPane = page.locator(`#pane-${id}`);
      await folderPane.getByRole("button", { name: "New folder", exact: true }).click();
      await folderPane.getByLabel("New folder path", { exact: true }).fill("created");
      await folderPane.getByRole("button", { name: "Create", exact: true }).click();
      await expect.poll(() => readdir(root)).toContain("created");
      await expect
        .poll(() => page.evaluate((id) => window.scope.guestFolderRecovery(id), id))
        .toBeUndefined();

      const upload = join(directory, "large-file.bin");
      await writeFile(upload, Buffer.alloc(33 * 1024 * 1024, 71));
      const plan = await prepare(page, id, [upload]);
      expect(plan.status, JSON.stringify(plan)).toBe("ok");
      if (plan.status !== "ok") throw new Error(plan.message);
      if (page === pageB) hubProxy.pauseNextUpload(3000);
      const copying = page.evaluate(
        (planId) => window.scope.startFolderDrop({ planId, choices: {} }),
        plan.planId,
      );
      if (page === pageB) {
        await page.locator(".guest-folder-recovery").waitFor();
        await capture("guest-folder-pending-light-laptop.png");
      }
      const copied = await copying;
      expect(copied.failed).toBeUndefined();
      expect(copied.written).toEqual(["large-file.bin"]);
      expect((await readFile(join(root, "large-file.bin"))).length).toBe(33 * 1024 * 1024);
      const downloaded = join(directory, root === rootA ? "download-a.bin" : "download-b.bin");
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, downloaded);
      expect(
        await page.evaluate(
          (tabId) => window.scope.saveFolderFile({ tabId, path: "large-file.bin" }),
          id,
        ),
      ).toBe(true);
      expect(
        createHash("sha256")
          .update(await readFile(downloaded))
          .digest("hex"),
      ).toBe(
        createHash("sha256")
          .update(await readFile(upload))
          .digest("hex"),
      );
      expect(await page.evaluate((id) => window.scope.guestFolderRecovery(id), id)).toBeUndefined();
    }
    const recoveryGuest = await guest(pageB, "Owner remote folder with a long project title");
    await select(pageB, recoveryGuest.tab.id);
    await guestFolderRecoveryChecks({
      page: pageB,
      tabId: recoveryGuest.tab.id,
      root: rootA,
      directory,
      proxy: hubProxy,
      prepare,
      restart: async () => {
        await right.close();
        right = await b.launch();
        pageB = await right.firstWindow();
        await select(pageB, recoveryGuest.tab.id);
        return pageB;
      },
      reconnect: pair,
      capture,
      resize: async (width) => {
        await right.evaluate(
          ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 768),
          width,
        );
      },
    });
    const record = await guest(pageB, "Owner remote folder with a long project title");
    const id = record.tab.id;
    await select(pageB, id);
    const pane = pageB.locator(`#pane-${id}`);
    await pane.getByRole("treeitem", { name: "docs", exact: true }).click();
    await pane.getByRole("treeitem", { name: "notes.md", exact: true }).click();
    await pane.getByText("Remote notes", { exact: false }).first().waitFor();
    const original = join(directory, "large-file.bin");
    await writeFile(original, "replacement input");
    const plan = await prepare(pageB, id, [original]);
    if (plan.status !== "ok") throw new Error(plan.message);
    expect(plan.clashes).toHaveLength(1);
    await writeFile(join(rootA, "large-file.bin"), "new external version");
    const conflict = await pageB.evaluate(
      (planId) => window.scope.startFolderDrop({ planId, choices: { "0": "replace" } }),
      plan.planId,
    );
    expect(conflict.failed).toContain("changed");
    expect(await readFile(join(rootA, "large-file.bin"), "utf8")).toBe("new external version");
    expect(
      (await pageB.evaluate((id) => window.scope.guestFolderRecovery(id), id))?.original?.path,
    ).toBe(original);
    await pane.getByRole("button", { name: "Check upload status" }).click();
    for (const appearance of ["light", "dark"] as const)
      for (const [label, width] of [
        ["laptop", 1366],
        ["narrow", 620],
      ] as const) {
        await pageB.getByRole("button", { name: "Search and controls" }).click();
        await pageB.getByRole("button", { name: "Settings", exact: true }).click();
        await pageB.getByLabel("Search settings").fill("appearance");
        await pageB.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await pageB
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await right.evaluate(
          ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 768),
          width,
        );
        await capture(`guest-folder-conflict-${appearance}-${label}.png`);
      }
    const ownerState = (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
      (tab) => tab.id === record.source.sourceTabId,
    )!.state.data;
    expect(ownerState.selectedPath).toBe(null);
    await right.close();
    right = await b.launch();
    pageB = await right.firstWindow();
    expect(
      (await pageB.evaluate((id) => window.scope.guestFolderRecovery(id), id))?.original?.path,
    ).toBe(original);
    expect(
      (await pageB.evaluate(() => window.scope.workspace()))!.tabs.find((tab) => tab.id === id)!
        .state.data.folder,
    ).toMatchObject({ selectedPath: "docs/notes.md", expanded: ["docs"] });
    await select(pageB, id);
    await capture("guest-folder-recovery-offline.png");
    // Linux test credentials are session-only, so explicit pairing reestablishes permission.
    await pair();
    await pageB.evaluate(async (tabId) => {
      const pending = await window.scope.guestFolderRecovery(tabId);
      await window.scope.guestFolderRelease({
        tabId,
        requestId: pending!.write.operation.requestId,
      });
    }, id);
    const replacement = await prepare(pageB, id, [original]);
    if (replacement.status !== "ok") throw new Error(replacement.message);
    const success = await pageB.evaluate(
      (planId) => window.scope.startFolderDrop({ planId, choices: { "0": "replace" } }),
      replacement.planId,
    );
    expect(success.failed).toBeUndefined();
    expect(await readFile(join(rootA, "large-file.bin"), "utf8")).toBe("replacement input");
    // The actual owner remote source refuses an old hub instead of weakening writes.
    hubProxy.old(true);
    const oldPlan = await prepare(pageB, id, [original]);
    expect(oldPlan.status).toBe("failed");
    if (oldPlan.status === "failed") expect(oldPlan.message).toMatch(/newer Scope|Update Scope/);
    hubProxy.old(false);
    const latest = (await guest(pageB, record.tab.title)).source;
    const expected = {
      target: { ownerDeviceId: record.ownerDeviceId, sourceTabId: record.source.sourceTabId },
      sourceVersion: latest.sourceVersion!,
    };
    const bytes = Buffer.from("ab");
    const slow = folderCommand("slow.txt", bytes);
    const progressing = await peerProxy.call(
      "upload",
      { ...expected, operation: slow },
      bytes,
      35_000,
    );
    expect(progressing.status).toBe(200);
    expect(progressing.value.state).toBe("completed");
    expect(progressing.elapsed).toBeGreaterThan(34_000);
    expect(await readFile(join(rootA, "slow.txt"), "utf8")).toBe("ab");
    const idle = folderCommand("idle.txt", bytes);
    const expired = await peerProxy.call("upload", { ...expected, operation: idle }, bytes, 65_000);
    expect(expired.status).toBe(0);
    expect(expired.elapsed).toBeGreaterThan(55_000);
    expect(expired.elapsed).toBeLessThan(64_000);
    const cancelled = folderCommand("cancelled.txt", bytes);
    expect(
      (await peerProxy.call("upload", { ...expected, operation: cancelled }, bytes, 35_000, 500))
        .status,
    ).toBe(0);
    await expect
      .poll(() =>
        readdir(rootA).then((names) =>
          names.filter(
            (name) =>
              name.startsWith(".scope-partial-") || ["idle.txt", "cancelled.txt"].includes(name),
          ),
        ),
      )
      .toEqual([]);
    expect(hubProxy.largestBuffer()).toBeLessThan(2 * 1024 * 1024);
    // Lose the host's acknowledgement, restart both host and owner, and query the original ID.
    const lostFile = join(directory, "lost-reply.txt");
    await writeFile(lostFile, "committed once");
    const lostPlan = await prepare(pageB, id, [lostFile]);
    if (lostPlan.status !== "ok") throw new Error(lostPlan.message);
    hubProxy.drop();
    const lost = await pageB.evaluate(
      (planId) => window.scope.startFolderDrop({ planId, choices: {} }),
      lostPlan.planId,
    );
    expect(lost.failed).toBeTruthy();
    const saved = await pageB.evaluate((id) => window.scope.guestFolderRecovery(id), id);
    expect(saved?.write.operation.requestId).toBeTruthy();
    expect(await readFile(join(rootA, "lost-reply.txt"), "utf8")).toBe("committed once");
    await ha.stop();
    await left.close();
    await ha.start();
    left = await a.launch();
    pageA = await left.firstWindow();
    // Restore only the same synthetic hub credential through the pairing API. No native credential claim.
    await pageA.evaluate((url) => window.scope.pairRemote(url), hubProxy.pairUrl(ha.pairUrl));
    await expect
      .poll(() =>
        pageA.evaluate(() => window.scope.remotes()).then((remotes) => remotes[0]?.connection),
      )
      .toBe("connected");
    await pair();
    const recovered = await pageB.evaluate((id) => window.scope.guestFolderStatus(id), id);
    expect(recovered?.write.operation.requestId).toBe(saved?.write.operation.requestId);
    expect(recovered?.outcome?.state).toBe("completed");
    await pageB.evaluate(async (tabId) => {
      const pending = await window.scope.guestFolderRecovery(tabId);
      await window.scope.guestFolderRelease({
        tabId,
        requestId: pending!.write.operation.requestId,
      });
    }, id);
    await ha.stop();
    await expect
      .poll(() =>
        pageB
          .evaluate((tabId) => window.scope.folderList({ tabId, path: "", showIgnored: false }), id)
          .then((result) => result.status),
      )
      .toBe("offline");
    const local = await guest(pageB, "Owner local folder");
    expect(
      (
        await pageB.evaluate(
          (tabId) => window.scope.folderList({ tabId, path: "", showIgnored: false }),
          local.tab.id,
        )
      ).status,
    ).toBe("ok");
    const note = await guest(pageB, "Owner note");
    const noteBytes = await pageB.evaluate(
      ({ id, revision }) =>
        window.scope
          .guestContent(id, revision)
          .then((content) => new TextDecoder().decode(content.bytes)),
      { id: note.tab.id, revision: note.source.artifact!.revision },
    );
    expect(noteBytes).toBe("Owner stays available");
    await capture("guest-folder-hub-offline.png");
    await ha.start();
    await expect
      .poll(
        () =>
          pageB
            .evaluate(
              (tabId) => window.scope.folderList({ tabId, path: "", showIgnored: false }),
              id,
            )
            .then((result) => result.status),
        { timeout: 20_000 },
      )
      .toBe("ok");
    const source = record.source.sourceTabId;
    const trashFile = join(directory, "trash-receipt.txt");
    await writeFile(trashFile, "retained status");
    const trashPlan = await prepare(pageB, id, [trashFile]);
    if (trashPlan.status !== "ok") throw new Error(trashPlan.message);
    hubProxy.drop();
    await pageB.evaluate(
      (planId) => window.scope.startFolderDrop({ planId, choices: {} }),
      trashPlan.planId,
    );
    const duringTrash = folderCommand("during-trash.txt", bytes);
    const cancelling = peerProxy.call(
      "upload",
      { ...expected, operation: duringTrash },
      bytes,
      35_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await pageA.evaluate((id) => window.scope.closeTab(id), source);
    await expect
      .poll(() =>
        pageB
          .evaluate(() => window.scope.guestCatalog())
          .then((view) => view.available.includes(id)),
      )
      .toBe(false);
    expect(
      (
        await pageB.evaluate(
          (tabId) => window.scope.folderList({ tabId, path: "", showIgnored: false }),
          id,
        )
      ).status,
    ).not.toBe("ok");
    expect((await cancelling).status).toBe(0);
    expect(
      (await pageB.evaluate((id) => window.scope.guestFolderStatus(id), id))?.outcome?.state,
    ).toBe("completed");
    const localRecord = await guest(pageB, "Owner local folder");
    const duringRevoke = peerProxy.call(
      "upload",
      {
        target: {
          ownerDeviceId: localRecord.ownerDeviceId,
          sourceTabId: localRecord.source.sourceTabId,
        },
        sourceVersion: localRecord.source.sourceVersion!,
        operation: folderCommand("during-revoke.txt", bytes),
      },
      bytes,
      35_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const currentPeer = (await pageA.evaluate(() => window.scope.transferDevices())).peers.at(
      -1,
    )!.id;
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, false), currentPeer);
    expect((await duringRevoke).status).toBe(0);
    await expect
      .poll(() =>
        readdir(rootA).then((names) =>
          names.filter(
            (name) =>
              name.startsWith(".scope-partial-") ||
              ["during-trash.txt", "during-revoke.txt"].includes(name),
          ),
        ),
      )
      .toEqual([]);
    await expect(pageB.evaluate((id) => window.scope.guestFolderStatus(id), id)).rejects.toThrow();
    await expect
      .poll(() =>
        pageB.evaluate(() => window.scope.guestCatalog()).then((view) => view.available.length),
      )
      .toBe(0);
  } finally {
    await left.close().catch(() => {});
    await right.close().catch(() => {});
    await ha.stop();
    await hb.stop();
    await peerProxy.close();
    await hubProxy.close();
    await rm(directory, { recursive: true, force: true });
    await rm(a.directory, { recursive: true, force: true });
    await rm(b.directory, { recursive: true, force: true });
  }
}
