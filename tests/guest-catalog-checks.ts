import { guestCloseLocalState } from "./guest-close-local-state.ts";
import { guestCloseFailureChecks, guestWorkspaceChecks } from "./guest-workspace-checks.ts";
import { spawnedHub } from "./hub-fixture.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { guestResponseFixture } from "./guest-response-fixture.ts";
import { expect } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { desktopFixture } from "./desktop-fixture.ts";

type Fixture = Awaited<ReturnType<typeof desktopFixture>>;

export async function guestCatalogChecks({
  a,
  b,
  left,
  right,
  pageA,
  pageB,
  responses,
}: {
  a: Fixture;
  b: Fixture;
  left: ElectronApplication;
  right: ElectronApplication;
  pageA: Page;
  pageB: Page;
  responses: Awaited<ReturnType<typeof guestResponseFixture>>;
}) {
  const ca = await a.connect();
  const cb = await b.connect();
  const metadata = {
    title: "Same title",
    name: "same-name",
    kind: "html",
    fileName: "example.html",
    mediaType: "text/html",
    expectedRevision: 0,
  };
  let current = await ca.publish(
    "same-id",
    metadata,
    Buffer.from(
      `<button onclick="this.textContent='Clicked'">Try guest</button><input aria-label="Local draft"><div style="height:2400px">Reading position</div><script src="http://127.0.0.1:${responses.port}/resource.js"></script>`,
    ),
  );
  await cb.publish("same-id", metadata, Buffer.from("<h1>Receiver local</h1>"));
  await expect
    .poll(() =>
      pageA
        .evaluate(() => window.scope.workspace())
        .then((workspace) =>
          workspace?.tabs.some((tab) => tab.state.data.artifactId === "same-id"),
        ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      pageB
        .evaluate(() => window.scope.workspace())
        .then((workspace) =>
          workspace?.tabs.some((tab) => tab.state.data.artifactId === "same-id"),
        ),
    )
    .toBe(true);
  const sourceTab = (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
    (tab) => tab.state.data.artifactId === "same-id",
  )!;
  const otherTab = (await pageB.evaluate(() => window.scope.workspace()))!.tabs.find(
    (tab) => tab.state.data.artifactId === "same-id",
  )!;
  // Synthetic pre-discovery profile deliberately collides source UUIDs across owners.
  const database = new DatabaseSync(join(b.settingsDirectory, "artifacts", "scope.db"));
  try {
    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    database
      .prepare("UPDATE live_tabs SET id = ?, document = json_set(document, '$.id', ?) WHERE id = ?")
      .run(sourceTab.id, sourceTab.id, otherTab.id);
    database
      .prepare("UPDATE artifacts SET tab_id = ? WHERE tab_id = ?")
      .run(sourceTab.id, otherTab.id);
    database
      .prepare("UPDATE tab_blobs SET tab_id = ? WHERE tab_id = ?")
      .run(sourceTab.id, otherTab.id);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  await pageB.reload();
  await pageB.locator(`#tab-${sourceTab.id}`).waitFor();
  await pageA.evaluate((id) => window.scope.setTabPermanent(id, true), sourceTab.id);
  await pageA.getByRole("button", { name: "Close Same title", exact: true }).click();
  await ca.folderOpen({ path: a.directory, title: "Owner folder" });
  const plan = {
    version: 1,
    title: "Owner plan",
    overviewHtml: "<h1>Native plan</h1>",
    context: "Synthetic catalog proposal.",
    constraints: [],
    questions: [],
    goals: [],
    visuals: [],
    checks: [],
    items: [],
    bases: [],
    agreements: [],
    evidence: [],
  };
  await ca.publish(
    "owner-plan",
    {
      title: "Owner plan",
      name: "owner-plan",
      kind: "plan",
      fileName: "plan.json",
      mediaType: "application/json",
      expectedRevision: 0,
    },
    Buffer.from(JSON.stringify(plan)),
  );
  const connection = JSON.parse(await readFile(a.connectionFile, "utf8"));
  await fetch(connection.endpoint + "/v1/artifacts/incomplete/tab", {
    method: "POST",
    headers: { Authorization: "Bearer " + connection.token, "Content-Type": "application/json" },
    body: '{"expectedRevision":0}',
  });
  await ca.publish(
    "excluded",
    {
      title: "Unsupported kind",
      kind: "custom-kind",
      fileName: "custom.bin",
      mediaType: "application/octet-stream",
      expectedRevision: 0,
    },
    Buffer.from("excluded"),
  );
  const source = () => pageB.evaluate(() => window.scope.guestCatalog());
  const own = () => pageA.evaluate(() => window.scope.guestCatalog());
  let guestId = "";
  let restartWorkspace = "";
  let localStateId = "";

  async function select(id: string) {
    const tab = pageB.locator(`#tab-${id}`);
    if (await tab.count()) {
      await tab.click();
      return;
    }
    await pageB.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    const record = (await source()).records.find((record) => record.tab.id === id)!;
    await pageB.getByRole("button", { name: record.tab.title + " guest", exact: true }).click();
  }
  async function capture(name: string, page = pageB) {
    if (!process.env.SCOPE_REVIEW_DIR) return;
    await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
    await page.screenshot({
      animations: "disabled",
      path: join(process.env.SCOPE_REVIEW_DIR, name),
    });
  }
  return {
    async connected() {
      await expect.poll(async () => (await source()).available.length, { timeout: 20000 }).toBe(3);
      await expect.poll(async () => (await own()).available.length).toBe(1);
      let view = await source();
      const record = view.records.find((record) => record.source.artifact?.id === "same-id")!;
      guestId = record.tab.id;
      expect(record.source.sourceTabId).toBe(sourceTab.id);
      const retainedSource = (await pageA.evaluate(() => window.scope.retainedTabs())).find(
        (entry) => entry.tab.id === sourceTab.id,
      )!;
      expect(retainedSource.permanent).toBe(true);
      expect(retainedSource.tab.hidden).toBe(true);
      expect(guestId).not.toBe(sourceTab.id);
      expect((await own()).records[0]!.source.sourceTabId).toBe(sourceTab.id);
      expect((await own()).records[0]!.ownerDeviceId).not.toBe(record.ownerDeviceId);
      expect(JSON.stringify(view)).not.toContain(a.directory);
      expect(JSON.stringify(view)).not.toContain(connection.token);
      expect(
        view.records.find((record) => record.source.kind === "plan")?.source.artifact?.kind,
      ).toBe("plan");
      expect((await cb.list()).map((item) => item.id)).toEqual(["same-id"]);
      const read = await pageB.evaluate(
        ({ guestId, revision }) =>
          window.scope
            .guestContent(guestId, revision)
            .then((item) => new TextDecoder().decode(item.bytes)),
        { guestId, revision: current.revision },
      );
      expect(read).toContain("Try guest");
      await expect
        .poll(() =>
          pageB
            .evaluate(() => window.scope.workspace())
            .then((workspace) => workspace?.tabs.some((tab) => tab.id === guestId)),
        )
        .toBe(true);
      responses.failNextContent();
      const contentReads = responses.reads();
      await select(guestId);
      const pane = pageB.locator(".artifact-pane:not([hidden])");
      await pane.getByText("Shared by", { exact: false }).waitFor();
      await pane.getByRole("alert").waitFor();
      expect(responses.reads()).toBe(contentReads + 1);
      const catalogRequests = responses.requests();
      // The content retry must work while catalog polls succeed at the unchanged source revision.
      await expect
        .poll(() => responses.requests(), { timeout: 25000 })
        .toBeGreaterThan(catalogRequests);
      const afterFailure = await source();
      expect(afterFailure.available).toContain(guestId);
      expect(
        afterFailure.records.find((entry) => entry.tab.id === guestId)?.source.artifact?.revision,
      ).toBe(current.revision);
      await capture("guest-content-retry.png");
      await pane
        .getByRole("button", { name: "Retry content", exact: true })
        .click({ timeout: 3000 });
      const frame = pane.locator("iframe").contentFrame();
      await frame.getByRole("button", { name: "Try guest" }).click();
      await frame.getByRole("button", { name: "Clicked" }).waitFor();
      await expect
        .poll(() => frame.locator("body").getAttribute("data-external-resource"))
        .toBe("loaded");
      await frame.getByLabel("Local draft").fill("Receiver navigation remains local");
      expect(responses.reads()).toBe(contentReads + 2);
      await pageB
        .locator(".artifact-tab.selected")
        .getByRole("button", { name: "Close Same title", exact: true })
        .click();
      await select(guestId);
      expect(await frame.getByLabel("Local draft").inputValue()).toBe(
        "Receiver navigation remains local",
      );
      await frame.getByRole("button", { name: "Clicked" }).waitFor();
      expect(responses.reads()).toBe(contentReads + 2);
      await guestWorkspaceChecks({
        pageA,
        pageB,
        right,
        settingsDirectory: b.settingsDirectory,
        guestId,
        responses,
        capture,
      });
      await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
      await capture("guest-html-light.png");
      await pageB.getByRole("button", { name: "Search and controls" }).click();
      await pageB.getByRole("button", { name: "Settings", exact: true }).click();
      await pageB.getByLabel("Search settings").fill("appearance");
      await pageB.getByLabel("Appearance", { exact: true }).selectOption("dark");
      await pageB
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await right.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(640, 820),
      );
      await capture("guest-html-dark-narrow.png");
      await frame.locator("body").evaluate(() => window.scrollTo(0, 480));
      await expect
        .poll(
          async () =>
            (await pageB.evaluate(() => window.scope.workspace()))?.tabs.find(
              (tab) => tab.id === guestId,
            )?.state.data.fileScroll,
        )
        .toEqual({ x: 0, y: 480 });
      const destination = join(b.directory, "download.html");
      await right.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      }, destination);
      expect(
        await pageB.evaluate(
          ({ guestId, revision }) => window.scope.guestDownload(guestId, revision),
          { guestId, revision: current.revision },
        ),
      ).toBe(true);
      expect(await readFile(destination, "utf8")).toContain("Try guest");
      responses.hold();
      const replacingRead = responses.held();
      current = await ca.publish(
        "same-id",
        { ...metadata, expectedRevision: current.revision },
        Buffer.from(
          "<h1>Current owner revision</h1>" +
            "<p>Current owner content keeps its receiver reading position.</p>".repeat(100),
        ),
      );
      await expect
        .poll(
          async () =>
            (await source()).records.find((record) => record.tab.id === guestId)?.source.artifact
              ?.revision,
        )
        .toBe(current.revision);
      view = await source();
      expect(
        view.records.find((record) => record.tab.id === guestId)?.tab.state.data.fileScroll,
      ).toEqual({ x: 0, y: 480 });
      await expect.poll(() => responses.held()).toBe(replacingRead + 1);
      expect(await pane.locator("iframe").count()).toBe(0);
      responses.release();
      await frame.getByRole("heading", { name: "Current owner revision" }).waitFor();
      const future = await ca.publish(
        "future",
        {
          title: "Future text",
          kind: "text",
          fileName: "future.txt",
          mediaType: "text/plain",
          expectedRevision: 0,
        },
        Buffer.from("future content"),
      );
      await expect.poll(async () => (await source()).available.length).toBe(4);
      expect(await pageB.getByRole("tab", { selected: true }).getAttribute("id")).toBe(
        `tab-${guestId}`,
      );
      const futureGuest = (await source()).records.find(
        (record) => record.source.artifact?.id === future.id,
      )!;
      expect(
        await pageB.evaluate(
          ({ id, revision }) =>
            window.scope
              .guestContent(id, revision)
              .then((item) => new TextDecoder().decode(item.bytes)),
          { id: futureGuest.tab.id, revision: future.revision },
        ),
      ).toBe("future content");
      await expect
        .poll(() =>
          pageA
            .evaluate(() => window.scope.workspace())
            .then((workspace) =>
              workspace?.tabs.some((tab) => tab.state.data.artifactId === future.id),
            ),
        )
        .toBe(true);
      const futureSource = (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
        (tab) => tab.state.data.artifactId === future.id,
      )!;
      expect(futureGuest.tab.guestReadRevision).toBeUndefined();
      await select(futureGuest.tab.id);
      await pageA.evaluate((id) => window.scope.closeTab(id), futureSource.id);
      await expect(
        pageB.evaluate(({ id, revision }) => window.scope.guestContent(id, revision), {
          id: futureGuest.tab.id,
          revision: future.revision,
        }),
      ).rejects.toThrow();
      await expect.poll(async () => (await source()).available.length).toBe(3);
      await pane.getByText(/may have expired, moved to Trashcan, or become ineligible/).waitFor();
      expect(await pane.locator(".guest-view").isVisible()).toBe(false);
      await capture("workspace-source-unavailable-dark-narrow.png");
      await pageA.evaluate((id) => window.scope.restoreTab(id), futureSource.id);
      await expect
        .poll(async () => (await source()).available.includes(futureGuest.tab.id))
        .toBe(true);
      expect(
        (await source()).records
          .filter((record) => record.source.sourceTabId === futureSource.id)
          .map((record) => record.tab.id),
      ).toEqual([futureGuest.tab.id]);
      await pane.getByText("future content", { exact: true }).waitFor();
      // Expiry belongs to the owner even while the receiver is viewing this tab.
      await pageA.evaluate((id) => window.scope.setTabHidden(id, true), futureSource.id);
      const expiry = new DatabaseSync(join(a.settingsDirectory, "artifacts", "scope.db"));
      try {
        expiry
          .prepare("UPDATE live_tabs SET last_visible_at = ? WHERE id = ?")
          .run(Date.now() - 2 * 86400000, futureSource.id);
        const before = expiry
          .prepare("SELECT last_visible_at FROM live_tabs WHERE id = ?")
          .get(futureSource.id);
        await pageB.evaluate((id) => window.scope.reportVisibleTabs([id]), futureGuest.tab.id);
        expect(
          expiry.prepare("SELECT last_visible_at FROM live_tabs WHERE id = ?").get(futureSource.id),
        ).toEqual(before);
        await pageA.evaluate(() => window.scope.checkTabRetention([]));
      } finally {
        expiry.close();
      }
      await expect
        .poll(async () => (await source()).available.includes(futureGuest.tab.id))
        .toBe(false);
      await pane.getByText(/may have expired, moved to Trashcan, or become ineligible/).waitFor();
      await ca.delete(future.id);
      await expect
        .poll(async () => (await source()).available.includes(futureGuest.tab.id))
        .toBe(false);
      expect((await own()).available).toHaveLength(1);
      const receiver = new DatabaseSync(join(b.settingsDirectory, "artifacts", "scope.db"), {
        readOnly: true,
      });
      try {
        expect(
          receiver
            .prepare(
              "SELECT count(*) AS n FROM live_tabs WHERE json_extract(document, '$.type') = 'guest'",
            )
            .get()?.n,
        ).toBe(0);
        expect(receiver.prepare("SELECT count(*) AS n FROM artifacts").get()?.n).toBe(1);
        expect(receiver.prepare("SELECT count(*) AS n FROM transfer_receipts").get()?.n).toBe(0);
      } finally {
        receiver.close();
      }
      for (const example of [
        {
          id: "markdown",
          kind: "markdown",
          mediaType: "text/markdown",
          fileName: "readme.md",
          content: Buffer.from("# Shared Markdown"),
        },
        {
          id: "text",
          kind: "text",
          mediaType: "text/plain",
          fileName: "note.txt",
          content: Buffer.from("Shared plain text"),
        },
        {
          id: "image",
          kind: "image",
          mediaType: "image/png",
          fileName: "image.png",
          content: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5kAAAAASUVORK5CYII=",
            "base64",
          ),
        },
      ]) {
        const artifact = await ca.publish(
          example.id,
          {
            title: "Shared " + example.id,
            kind: example.kind,
            mediaType: example.mediaType,
            fileName: example.fileName,
            expectedRevision: 0,
          },
          example.content,
        );
        await expect.poll(async () => (await source()).available.length).toBe(4);
        const record = (await source()).records.find(
          (record) => record.source.artifact?.id === example.id,
        )!;
        await select(record.tab.id);
        if (example.kind === "markdown")
          await pane.getByRole("heading", { name: "Shared Markdown" }).waitFor();
        if (example.kind === "text")
          await pane.getByText("Shared plain text", { exact: true }).waitFor();
        if (example.kind === "image") await pane.getByRole("img").waitFor();
        const content = await pageB.evaluate(
          ({ id, revision }) =>
            window.scope.guestContent(id, revision).then((item) => Array.from(item.bytes)),
          { id: record.tab.id, revision: artifact.revision },
        );
        expect(content).toEqual([...example.content]);
        await ca.delete(example.id);
        await expect.poll(async () => (await source()).available.length).toBe(3);
      }
      const hub = await spawnedHub(join(a.directory, "hub"));
      try {
        await pageA.evaluate((url) => window.scope.pairRemote(url), hub.pairUrl);
        await expect
          .poll(() =>
            pageA.evaluate(() => window.scope.remotes()).then((remotes) => remotes[0]?.connection),
          )
          .toBe("connected");
        const remoteClient = new ScopeClient(hub.endpoint, hub.token);
        const published = await remoteClient.publish(
          "hub-owned",
          {
            title: "Hub publication",
            kind: "text",
            fileName: "hub.txt",
            mediaType: "text/plain",
            expectedRevision: 0,
            source: { host: "synthetic-hub", cwd: a.directory },
          },
          Buffer.from("hub publication content"),
        );
        await expect.poll(async () => (await source()).available.length).toBe(4);
        const guest = (await source()).records.find(
          (record) => record.source.artifact?.id === published.id,
        )!;
        expect(guest.source.artifact?.source).toBeUndefined();
        expect(
          await pageB.evaluate(
            ({ id, revision }) =>
              window.scope
                .guestContent(id, revision)
                .then((item) => new TextDecoder().decode(item.bytes)),
            { id: guest.tab.id, revision: published.revision },
          ),
        ).toBe("hub publication content");
        expect(await pageB.evaluate(() => window.scope.remotes())).toHaveLength(0);
        await ca.delete(published.id);
        await expect.poll(async () => (await source()).available.length).toBe(3);
      } finally {
        await hub.stop();
      }
      // A reply already in transit cannot revive content after source removal.
      let large = await ca.publish(
        "large",
        {
          title: "Large download",
          kind: "file",
          fileName: "large.bin",
          mediaType: "application/octet-stream",
          expectedRevision: 0,
        },
        Buffer.alloc(32 * 1024 * 1024, 7),
      );
      await expect.poll(async () => (await source()).available.length).toBe(4);
      const largeGuest = (await source()).records.find(
        (record) => record.source.artifact?.id === large.id,
      )!;
      expect(
        await pageB.evaluate(
          ({ id, revision }) =>
            window.scope.guestContent(id, revision).then((item) => item.bytes.length),
          { id: largeGuest.tab.id, revision: large.revision },
        ),
      ).toBe(32 * 1024 * 1024);
      await select(largeGuest.tab.id);
      await pane.getByText("Use Download to save this file.").waitFor();
      responses.hold();
      const held = responses.held();
      const late = pageB.evaluate(
        ({ id, revision }) =>
          window.scope.guestContent(id, revision).then(
            () => "accepted",
            () => "rejected",
          ),
        { id: largeGuest.tab.id, revision: large.revision },
      );
      await expect.poll(() => responses.held(), { timeout: 15000 }).toBe(held + 1);
      large = await ca.publish(
        large.id,
        {
          title: "Large download",
          kind: "file",
          fileName: "large.bin",
          mediaType: "application/octet-stream",
          expectedRevision: large.revision,
        },
        Buffer.alloc(32 * 1024 * 1024, 8),
      );
      await expect
        .poll(
          async () =>
            (await source()).records.find((record) => record.tab.id === largeGuest.tab.id)?.source
              .artifact?.revision,
        )
        .toBe(large.revision);
      responses.release();
      expect(await late).toBe("rejected");
      responses.pause();
      const heldBeforeTrash = responses.held();
      const duringTrash = pageB.evaluate(
        ({ id, revision }) =>
          window.scope.guestContent(id, revision).then(
            () => "accepted",
            () => "rejected",
          ),
        { id: largeGuest.tab.id, revision: large.revision },
      );
      await expect.poll(() => responses.held()).toBe(heldBeforeTrash + 1);
      const largeSource = (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
        (tab) => tab.state.data.artifactId === large.id,
      )!;
      await pageA.evaluate((id) => window.scope.closeTab(id), largeSource.id);
      await expect
        .poll(async () => (await source()).available.includes(largeGuest.tab.id))
        .toBe(false);
      responses.release();
      expect(await duringTrash).toBe("rejected");
      await ca.delete(large.id);
      // A failed or unsupported full refresh retains references without pretending they are current.
      const retained = (await source()).records.map((record) => record.tab.id).sort();
      for (const mode of [
        "unsupported",
        "unknown-kind",
        "partial",
        "stale",
        "same-revision",
      ] as const) {
        responses.mode(mode);
        await ca.publish(
          "wake",
          {
            title: "Wake catalog",
            kind: "text",
            fileName: "wake.txt",
            mediaType: "text/plain",
            expectedRevision: 0,
          },
          Buffer.from("wake"),
        );
        await expect
          .poll(async () => (await source()).available.length, { timeout: 30000 })
          .toBe(0);
        expect((await source()).records.map((record) => record.tab.id).sort()).toEqual(retained);
        if (mode === "unsupported") expect((await source()).owners[0]?.message).toMatch(/update/i);
        await ca.delete("wake");
        responses.mode("normal");
        await expect
          .poll(async () => (await source()).available.length, { timeout: 30000 })
          .toBe(3);
      }
      // Plans retain their compatibility view; folders use their native presentation.
      const planRecord = view.records.find((record) => record.source.kind === "plan")!;
      await select(planRecord.tab.id);
      await pageB.getByText(/Update Scope to open shared plans/).waitFor();
      expect(planRecord.source.artifact!.kind).toBe("plan");
      await capture("guest-plan-placeholder.png");
      await select(view.records.find((record) => record.source.kind === "folder")!.tab.id);
      await pageB.getByRole("region", { name: "Owner folder folder" }).getByRole("tree").waitFor();
      await capture("guest-folder-native.png");
    },
    async reconnected() {
      await expect.poll(async () => (await source()).available.length, { timeout: 25000 }).toBe(3);
      const record = (await source()).records.find(
        (record) => record.source.artifact?.id === "same-id",
      )!;
      expect(record.tab.id).toBe(guestId);
      expect(record.source.artifact?.revision).toBe(current.revision);
      expect(
        (await source()).records.filter((record) => record.source.sourceTabId === sourceTab.id),
      ).toHaveLength(1);
      const text = await pageB.evaluate(
        ({ id, revision }) =>
          window.scope
            .guestContent(id, revision)
            .then((item) => new TextDecoder().decode(item.bytes)),
        { id: guestId, revision: current.revision },
      );
      expect(text).toContain("Current owner revision");
    },
    async restarted(page: Page, restartedApp: ElectronApplication) {
      await expect
        .poll(() =>
          page
            .evaluate(() => window.scope.guestCatalog())
            .then((view) => view.records.some((record) => record.tab.id === guestId)),
        )
        .toBe(true);
      const saved = await page.evaluate(() => window.scope.workspace());
      expect(saved!.tabs.find((tab) => tab.id === localStateId)?.state.data.divider).toBe(0.85);
      expect(JSON.stringify(saved)).toBe(restartWorkspace);
      const database = new DatabaseSync(join(b.settingsDirectory, "desktop.db"));
      database.exec("DROP TRIGGER reject_guest_close");
      database.close();
      expect(saved!.tabs.find((tab) => tab.id === saved!.selected)?.hidden).toBe(false);
      await page.locator(`#tab-${saved!.selected}`).waitFor({ state: "visible" });
      const hidden = saved!.tabs.find((tab) => tab.id === guestId)!;
      expect(hidden.hidden).toBe(true);
      expect(
        saved!.tabs.find((tab) => tab.title === "Hub publication")?.guestReadRevision,
      ).toBeUndefined();
      await page
        .getByRole("button", { name: /^Tabs and Trashcan,/ })
        .getByRole("img", { name: "Updated artifact" })
        .waitFor();
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await page.getByLabel("Search tabs", { exact: true }).fill(hidden.title);
      await page.getByRole("button", { name: hidden.title + " guest", exact: true }).click();
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.workspace()))?.selected)
        .toBe(guestId);
      expect(await page.locator(`#pane-${guestId} iframe`).count()).toBe(0);
      await page
        .locator(`#pane-${guestId}`)
        .getByText(/This owner is no longer paired/)
        .waitFor();
      await capture("workspace-forgotten-dark-laptop.png", page);
      expect(
        (await page.evaluate(() => window.scope.workspace()))?.tabs.find(
          (tab) => tab.id === guestId,
        )?.id,
      ).toBe(guestId);
      const view = await page.evaluate(() => window.scope.guestCatalog());
      expect(view.available).toHaveLength(0);
      expect(view.records.find((record) => record.tab.id === guestId)?.source.sourceTabId).toBe(
        sourceTab.id,
      );
      expect((await (await b.connect()).list()).map((item) => item.id)).toEqual(["same-id"]);
      // Linux credentials are session-only. Pair again explicitly, then restore the saved reader.
      const invitation = await pageA.evaluate(() => window.scope.createPairing("Source Scope"));
      await pageA.evaluate((id) => window.scope.copyPairingSecret(id), invitation.id);
      const secret = await left.evaluate(({ clipboard }) => clipboard.readText());
      await page.evaluate((input) => window.scope.pairScope(input), {
        url: invitation.url,
        secret,
        name: "Guest Scope",
      });
      const peer = (await page.evaluate(() => window.scope.transferDevices())).peers[0]!.id;
      await pageA.evaluate((id) => window.scope.setGuestAccess(id, true), peer);
      await page.evaluate((id) => window.scope.setGuestAccess(id, true), peer);
      await pageA.evaluate((id) => window.scope.copyGuestLink(id), peer);
      const link = await left.evaluate(({ clipboard }) => clipboard.readText());
      await restartedApp.evaluate(({ clipboard }, link) => clipboard.writeText(link), link);
      await page.evaluate((id) => window.scope.connectGuestLink(id), peer);
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.scope.guestCatalog())).available.includes(guestId),
          { timeout: 25000 },
        )
        .toBe(true);
      const frame = page.locator(`#pane-${guestId} iframe`).contentFrame();
      await frame.getByRole("heading", { name: "Current owner revision" }).waitFor();
      await expect.poll(() => frame.locator("body").evaluate(() => window.scrollY)).toBe(480);
      expect((await page.evaluate(() => window.scope.workspace()))?.selected).toBe(guestId);
      await capture("workspace-reopened-reader-dark-laptop.png", page);
    },
    async revoked() {
      await expect(
        pageB.evaluate(({ id, revision }) => window.scope.guestContent(id, revision), {
          id: guestId,
          revision: current.revision,
        }),
      ).rejects.toThrow();
      await expect.poll(async () => (await source()).available.length, { timeout: 25000 }).toBe(0);
      expect((await source()).records.some((record) => record.tab.id === guestId)).toBe(true);
      await pageB
        .locator(".artifact-pane:not([hidden])")
        .getByText(/Source Scope (is unavailable|rejected guest access)/)
        .waitFor();
      await capture("guest-owner-unavailable.png");
      await select(guestId);
      const peer = (await pageB.evaluate(() => window.scope.transferDevices())).peers[0]!.id;
      await pageB.evaluate((id) => window.scope.setGuestAccess(id, false), peer);
      await pageB
        .locator(`#pane-${guestId}`)
        .getByText(/Guest sharing with Source Scope is off on this Scope/)
        .waitFor();
      await capture("workspace-disabled-dark-narrow.png");
      await pageB.evaluate((id) => window.scope.forgetScope(id), peer);
      await pageB
        .locator(`#pane-${guestId}`)
        .getByText(/This owner is no longer paired/)
        .waitFor();
      await pageB
        .locator(".artifact-tab.selected")
        .getByRole("button", { name: "Close Same title", exact: true })
        .click();
      const planId = (await source()).records.find((record) => record.source.kind === "plan")!.tab
        .id;
      await select(planId);
      await pageB.locator(`#tab-${planId}`).focus();
      for (let i = 0; i < 3; i++) await pageB.keyboard.press("Alt+ArrowLeft");
      await expect
        .poll(
          async () =>
            (await pageB.evaluate(() => window.scope.workspace()))?.tabs.find(
              (tab) => tab.id === guestId,
            )?.hidden,
        )
        .toBe(true);
      await expect
        .poll(async () => (await pageB.evaluate(() => window.scope.workspace()))?.selected)
        .toBe(planId);
      await expect
        .poll(
          async () =>
            (await pageB.evaluate(() => window.scope.workspace()))?.tabs.filter(
              (tab) => !tab.hidden,
            )[0]?.id,
        )
        .toBe(planId);
      await guestCloseFailureChecks(pageB, b.settingsDirectory, planId, right);
      const workspace = (await pageB.evaluate(() => window.scope.workspace()))!;
      const local = workspace.tabs.findIndex((tab) => tab.type === "file");
      expect(workspace.tabs.slice(0, local).some((tab) => tab.type === "guest")).toBe(true);
      expect(workspace.tabs.slice(local + 1).some((tab) => tab.type === "guest")).toBe(true);
      const database = new DatabaseSync(join(b.settingsDirectory, "desktop.db"));
      database.exec("DROP TRIGGER reject_guest_close");
      database.close();
      const folderId = (await source()).records.find((record) => record.source.kind === "folder")!
        .tab.id;
      localStateId = await guestCloseLocalState(pageB, right, folderId);
      const afterClose = (await pageB.evaluate(() => window.scope.workspace()))!;
      restartWorkspace = JSON.stringify({
        ...afterClose,
        tabs: afterClose.tabs.map((tab) =>
          tab.id === localStateId
            ? { ...tab, state: { ...tab.state, data: { ...tab.state.data, divider: 0.85 } } }
            : tab,
        ),
      });
      const fault = new DatabaseSync(join(b.settingsDirectory, "desktop.db"));
      fault.exec(`CREATE TRIGGER reject_guest_close BEFORE UPDATE ON preferences
        WHEN NEW.name = 'workspace_layout' AND json_extract(NEW.document, '$.selected') IS NOT json_extract(OLD.document, '$.selected')
        BEGIN SELECT RAISE(ABORT, 'Synthetic selection write failure'); END`);
      fault.close();
    },
  };
}
