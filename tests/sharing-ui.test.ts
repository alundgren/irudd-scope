import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { sharingFixture } from "./sharing-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";

test("human confirmation creates a frozen share, refresh retains its link, and tab deletion leaves it available", async () => {
  const f = await desktopFixture();
  const service = await sharingFixture();
  const app = await f.launch();
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const page = await app.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByLabel("Search settings").fill("public sharing");
    await page.getByText("No sharing services paired.").waitFor();
    await page.getByLabel("Sharing service pairing URL").fill(service.pairUrl());
    await page.getByRole("button", { name: "Pair sharing service", exact: true }).click();
    await page.getByText("Connected · 0 shared copies").waitFor();
    expect(await page.getByLabel("Sharing service pairing URL").inputValue()).toBe("");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await f.cli(
      "text",
      "First frozen text",
      "--id",
      "public-text",
      "--title",
      "Presentation with a very long title for sharing at a narrow width",
    );
    await page.getByText("First frozen text", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Share tab", exact: true }).click();
    await page.getByRole("button", { name: "Share publicly…", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Share publicly…", exact: true }).isEnabled())
      .toBe(true);
    expect(service.ports).toHaveLength(0);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole("button", { name: "Share publicly…", exact: true }).click();
    const link = page.getByLabel("Public share link");
    await link.waitFor();
    const url = await link.inputValue();
    const original = service.store.list()[0];
    const local = `http://127.0.0.1:${service.ports[0]}${new URL(url).pathname}`;
    expect(await (await fetch(local)).text()).toBe("First frozen text");
    expect(await page.getByRole("img", { name: "Scan to open the shared copy" }).count()).toBe(1);
    const replacement = join(f.directory, "replacement.txt");
    await writeFile(replacement, "Refreshed frozen text");
    await f.cli("update", "public-text", replacement);
    expect(await (await fetch(local)).text()).toBe("First frozen text");
    await page.getByRole("button", { name: "Refresh shared content", exact: true }).click();
    await expect.poll(async () => (await fetch(local)).text()).toBe("Refreshed frozen text");
    expect(await link.inputValue()).toBe(url);
    expect(service.store.list()[0].expiresAt).toBe(original.expiresAt);
    for (const appearance of ["light", "dark"] as const) {
      await page.evaluate(async (value) => {
        await window.scope.saveSettings({ appearance: value });
        document.documentElement.dataset.theme = value;
      }, appearance);
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820),
        appearance === "light" ? 1280 : 640,
      );
      await expect
        .poll(() => page.evaluate(() => window.innerWidth))
        .toBe(appearance === "light" ? 1280 : 640);
      await link.focus();
      expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      if (process.env.SCOPE_REVIEW_DIR) {
        await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          path: join(process.env.SCOPE_REVIEW_DIR, `sharing-${appearance}.png`),
        });
      }
    }
    await page
      .getByRole("dialog", { name: "Share tab", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.keyboard.press("ControlOrMeta+w");
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect(await (await fetch(local)).text()).toBe("Refreshed frozen text");
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Public shares", exact: true }).click();
    await page.getByLabel("Public share link").waitFor();
    await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
    await page.getByText("No active shares.").waitFor();
    await expect(fetch(local)).rejects.toThrow();
  } finally {
    await app.close();
    await service.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);

test("desktop sharing exports HTML bytes, rendered Markdown, images, and diagram PNGs", async () => {
  const f = await desktopFixture();
  const service = await sharingFixture();
  const app = await f.launch();
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    await page.evaluate((url) => window.scope.pairSharing(url), service.pairUrl());
    const samples = [
      {
        id: "share-html",
        file: "page.html",
        bytes: Buffer.from(
          '<!doctype html><meta charset="utf-8"><h1>Shared HTML</h1><script>window.synthetic=1</script>',
        ),
        mediaType: "text/html",
      },
      {
        id: "share-markdown",
        file: "note.md",
        bytes: Buffer.from(
          '# Shared Markdown\n\n[Link label](https://example.invalid)\n\n<img src="https://example.invalid/image">',
        ),
        mediaType: "text/html",
      },
      {
        id: "share-image",
        file: "image.png",
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=",
          "base64",
        ),
        mediaType: "image/png",
      },
      {
        id: "share-diagram",
        file: "diagram.excalidraw",
        bytes: Buffer.from(JSON.stringify(nativeDiagram(2))),
        mediaType: "image/png",
      },
    ];
    for (const sample of samples) {
      const path = join(f.directory, sample.file);
      await writeFile(path, sample.bytes);
      await f.cli("add", path, "--id", sample.id, "--title", sample.id);
      await page.getByRole("tab", { name: sample.id, exact: true }).click();
      await page.getByRole("tabpanel", { name: sample.id, exact: true }).waitFor();
      if (sample.id === "share-diagram")
        await page
          .getByRole("tabpanel", { name: sample.id, exact: true })
          .locator("canvas.interactive")
          .waitFor();
      const share = await page.evaluate(async (artifactId) => {
        const tab = (await window.scope.workspace())!.tabs.find(
          (item) => item.state.data.artifactId === artifactId,
        )!;
        return window.scope.shareTab((await window.scope.sharing())[0].id, tab.id);
      }, sample.id);
      expect(share?.status).toBe("active");
      const response = await fetch(
        `http://127.0.0.1:${service.ports.at(-1)}${new URL(share!.url!).pathname}`,
      );
      expect(response.headers.get("content-type")).toBe(sample.mediaType);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sample.id === "share-markdown") {
        expect(bytes.toString()).toContain("<h1>Shared Markdown</h1>");
        expect(bytes.toString()).toContain("Link label");
        expect(bytes.toString()).not.toContain("https://example.invalid");
        expect(bytes.toString()).not.toContain("<img");
      } else if (sample.id === "share-diagram")
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
      else expect(bytes).toEqual(sample.bytes);
      await page.evaluate(
        async (id) => window.scope.stopShare((await window.scope.sharing())[0].id, id),
        share!.id,
      );
    }
  } finally {
    await app.close();
    await service.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
