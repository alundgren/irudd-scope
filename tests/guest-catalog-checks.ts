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
      `<button onclick="this.textContent='Clicked'">Try guest</button><input aria-label="Local draft"><script src="http://127.0.0.1:${responses.port}/resource.js"></script>`,
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
  async function capture(name: string) {
    if (!process.env.SCOPE_REVIEW_DIR) return;
    await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
    await pageB.screenshot({
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
      await pageB.evaluate(async (id) => {
        const workspace = (await window.scope.workspace())!;
        await window.scope.saveWorkspace({
          ...workspace,
          tabs: workspace.tabs.map((tab) =>
            tab.id === id
              ? { ...tab, state: { version: 1, data: { selected: "local-only" } } }
              : tab,
          ),
        });
      }, guestId);
      current = await ca.publish(
        "same-id",
        { ...metadata, expectedRevision: current.revision },
        Buffer.from("<h1>Current owner revision</h1>"),
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
        view.records.find((record) => record.tab.id === guestId)?.tab.state.data.selected,
      ).toBe("local-only");
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
      await pageA.evaluate((id) => window.scope.closeTab(id), futureSource.id);
      await expect(
        pageB.evaluate(({ id, revision }) => window.scope.guestContent(id, revision), {
          id: futureGuest.tab.id,
          revision: future.revision,
        }),
      ).rejects.toThrow();
      await expect.poll(async () => (await source()).available.length).toBe(3);
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
      // Plans and folders retain their types and show a deliberate compatibility view.
      const planRecord = view.records.find((record) => record.source.kind === "plan")!;
      await select(planRecord.tab.id);
      await pageB.getByText(/Update Scope to open shared plans/).waitFor();
      expect(planRecord.source.artifact!.kind).toBe("plan");
      await capture("guest-plan-placeholder.png");
      await select(view.records.find((record) => record.source.kind === "folder")!.tab.id);
      await pageB.getByText(/Update Scope to open shared folders/).waitFor();
      await capture("guest-folder-placeholder.png");
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
    async restarted(page: Page) {
      await expect
        .poll(() =>
          page
            .evaluate(() => window.scope.guestCatalog())
            .then((view) => view.records.some((record) => record.tab.id === guestId)),
        )
        .toBe(true);
      const view = await page.evaluate(() => window.scope.guestCatalog());
      expect(view.available).toHaveLength(0);
      expect(view.records.find((record) => record.tab.id === guestId)?.source.sourceTabId).toBe(
        sourceTab.id,
      );
      expect((await (await b.connect()).list()).map((item) => item.id)).toEqual(["same-id"]);
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
        .getByText(/Source Scope is unavailable. Reconnect to read current content./)
        .waitFor();
      await capture("guest-owner-unavailable.png");
    },
  };
}
