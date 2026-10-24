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
}: {
  a: Fixture;
  b: Fixture;
  left: ElectronApplication;
  right: ElectronApplication;
  pageA: Page;
  pageB: Page;
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
      '<button onclick="this.textContent=\'Clicked\'">Try guest</button><input aria-label="Local draft">',
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
      await select(guestId);
      const pane = pageB.locator(".artifact-pane:not([hidden])");
      await pane.getByText("Shared by", { exact: false }).waitFor();
      const frame = pane.locator("iframe").contentFrame();
      await frame.getByRole("button", { name: "Try guest" }).click();
      await frame.getByRole("button", { name: "Clicked" }).waitFor();
      await frame.getByLabel("Local draft").fill("Receiver navigation remains local");
      await capture("guest-html-light.png");
      await pageB.evaluate(() => window.scope.saveSettings({ appearance: "dark" }));
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
    async revoked() {
      await expect(
        pageB.evaluate(({ id, revision }) => window.scope.guestContent(id, revision), {
          id: guestId,
          revision: current.revision,
        }),
      ).rejects.toThrow();
      await expect.poll(async () => (await source()).available.length, { timeout: 25000 }).toBe(0);
      expect((await source()).records.some((record) => record.tab.id === guestId)).toBe(true);
      await capture("guest-owner-unavailable.png");
    },
  };
}
