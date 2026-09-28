import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";
import type { NativeDiagram } from "@irudd-scope/protocol/diagram-sync";

test("background diagrams fit when first shown, including after restart", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  try {
    let page = await application.firstWindow();
    let client = await fixture.connect();
    await client.publish(
      "reading",
      {
        title: "Reading",
        kind: "text",
        mediaType: "text/plain",
        fileName: "reading.txt",
        expectedRevision: 0,
      },
      Buffer.from("Keep this tab selected while diagrams arrive."),
    );
    await page.getByRole("tab", { name: "Reading" }).waitFor();
    const initial = nativeDiagram(3);
    const document: NativeDiagram = {
      ...initial,
      elements: initial.elements.map((element) => ({
        ...element,
        x: Number(element.x) + 4200,
        y: Number(element.y) - 2600,
      })),
    };
    for (const id of ["first", "after-restart"]) {
      await client.publish(
        id,
        {
          title: id,
          kind: "excalidraw",
          mediaType: "application/vnd.excalidraw+json",
          fileName: `${id}.excalidraw`,
          expectedRevision: 0,
        },
        Buffer.from(JSON.stringify(document)),
      );
      await page.getByRole("tab", { name: id, exact: true }).waitFor();
      const workspace = await page.evaluate(() => window.scope.workspace());
      const tabId = workspace!.tabs.find((tab) => tab.title === id)!.id;
      await expect
        .poll(() => page.evaluate((id) => window.scope.diagramDraft(id), tabId))
        .not.toBeNull();
    }
    expect(await page.getByRole("tab", { selected: true }).textContent()).toContain("Reading");
    async function expectFitted(id: string) {
      await page.getByRole("tab", { name: id, exact: true }).click();
      const selected = page.getByRole("tab", { name: id, selected: true, exact: true });
      await selected.waitFor();
      const tabId = (await selected.getAttribute("id"))!.slice(4);
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))?.viewport?.zoom,
          { timeout: 8000 },
        )
        .toBeGreaterThan(0.5);
      const viewport = (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))!
        .viewport!;
      const canvas = await page
        .getByRole("tabpanel", { name: id, exact: true })
        .locator("canvas.interactive")
        .boundingBox();
      for (const element of document.elements) {
        const x = (Number(element.x) + viewport.scrollX) * viewport.zoom;
        const y = (Number(element.y) + viewport.scrollY) * viewport.zoom;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + Number(element.width) * viewport.zoom).toBeLessThanOrEqual(canvas!.width);
        expect(y + Number(element.height) * viewport.zoom).toBeLessThanOrEqual(canvas!.height);
      }
    }
    await expectFitted("first");
    await application.close();
    application = await fixture.launch();
    page = await application.firstWindow();
    client = await fixture.connect();
    await expectFitted("after-restart");
    expect((await client.get("after-restart")).revision).toBe(1);
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
