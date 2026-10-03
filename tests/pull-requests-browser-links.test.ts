import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";

const html = `<!doctype html><a id="ordinary" href="https://github.com/synthetic/private/pull/1">Open PR</a>
<a id="blank" href="https://github.com/synthetic/private/pull/2" target="_blank">Open new</a>
<a id="top" href="https://github.com/synthetic/private/pull/3" target="_top">Open top</a>
<a id="window-cancelled" href="https://github.com/synthetic/private/pull/7">Window action</a>
<a id="stopped" href="https://github.com/synthetic/private/pull/8" onclick="event.stopPropagation()">Stopped link</a>
<a id="stopped-popup" href="https://github.com/synthetic/private/pull/9" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">Stopped popup</a>
<a id="cancelled-anchor" href="#section">Cancelled jump</a>
<a id="cancelled" href="https://github.com/synthetic/private/pull/5" onclick="event.preventDefault()">Custom action</a>
<a id="scripted" href="https://github.com/synthetic/private/pull/6" onclick="event.preventDefault(); window.open(this.href)">Custom popup</a>
<a id="anchor" href="#section">Jump</a><div id="section">Same document</div>
<script>addEventListener('click', event => {if(['window-cancelled', 'cancelled-anchor'].includes(event.target.id)) event.preventDefault();});addEventListener('scope-pull-requests-external-error', event => {document.body.dataset.failure = event.detail.message;});</script>`;

async function offlineFixture() {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-links-gh-"));
  await writeFile(join(ghDirectory, "gh"), '#!/bin/sh\necho "Synthetic offline" >&2\nexit 1\n', {
    mode: 0o700,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${ghDirectory}:${previousPath}`;
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  try {
    fixture = await desktopFixture();
  } finally {
    process.env.PATH = previousPath;
  }
  return { ...fixture, ghDirectory };
}

test("PR inbox links use the default browser across targets, modifiers, popups, and failed reads", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  try {
    await app.evaluate(({ shell }) => {
      const state = { urls: [] as string[], fail: false };
      Object.assign(globalThis, { externalLinksTest: state });
      shell.openExternal = async (url) => {
        if (state.fail) throw new Error("Synthetic browser launch failure");
        state.urls.push(url);
      };
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5_000);
    const artifact = await page.evaluate(
      async (html) =>
        window.scope.createPullRequests({
          name: "links-inbox",
          title: "Browser links",
          html,
          repository: { owner: "synthetic", name: "private" },
        }),
      html,
    );
    const frame = page.frameLocator(".pull-requests-document");
    await frame.locator("#ordinary").waitFor();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.scope.workspace()))?.tabs.some(
          (t) => t.state.data.artifactId === artifact.id,
        ),
      )
      .toBe(true);
    const tabId = (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
      (t) => t.state.data.artifactId === artifact.id,
    )!.id;
    const urls = () =>
      app.evaluate(
        () =>
          (globalThis as unknown as { externalLinksTest: { urls: string[] } }).externalLinksTest
            .urls,
      );
    let expected = 0;
    async function opened(url: string) {
      expected++;
      await expect.poll(async () => (await urls()).length).toBe(expected);
      expect((await urls()).at(-1)).toBe(url);
      expect(await page.locator(".pull-requests-document").count()).toBe(1);
      expect(app.windows().length).toBe(1);
    }
    await frame.locator("#ordinary").click();
    await opened("https://github.com/synthetic/private/pull/1");
    await frame.locator("#blank").click();
    await opened("https://github.com/synthetic/private/pull/2");
    // macOS Control-click opens a context menu rather than activating the link.
    for (const modifier of (["Control", "Meta", "Shift"] as const).filter(
      (value) => process.platform !== "darwin" || value !== "Control",
    )) {
      await frame.locator("#ordinary").click({ modifiers: [modifier] });
      await opened("https://github.com/synthetic/private/pull/1");
    }
    await frame.locator("#ordinary").click({ button: "middle" });
    await opened("https://github.com/synthetic/private/pull/1");
    await frame.locator("#ordinary").focus();
    await page.keyboard.press("Enter");
    await opened("https://github.com/synthetic/private/pull/1");
    expect(
      await frame
        .locator("body")
        .evaluate(() => window.open("https://github.com/synthetic/private/pull/4") === null),
    ).toBe(true);
    await opened("https://github.com/synthetic/private/pull/4");
    await frame.locator("#window-cancelled").click();
    await frame.locator("#cancelled-anchor").click();
    expect(await frame.locator("body").evaluate(() => location.hash)).toBe("");
    await frame.locator("#stopped").click();
    await opened("https://github.com/synthetic/private/pull/8");
    await frame.locator("#stopped-popup").click();
    await opened("https://github.com/synthetic/private/pull/9");
    await frame.locator("#stopped-popup").click({ button: "middle" });
    await opened("https://github.com/synthetic/private/pull/9");
    await frame.locator("#stopped-popup").click({ modifiers: ["ControlOrMeta"] });
    await opened("https://github.com/synthetic/private/pull/9");
    await frame.locator("#cancelled").click();
    await frame.locator("#scripted").click();
    await opened("https://github.com/synthetic/private/pull/6");
    await frame.locator("#anchor").click({ noWaitAfter: true });
    expect(await frame.locator("body").evaluate(() => location.hash)).toBe("#section");
    expect((await urls()).length).toBe(expected);

    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler("scope:pull-requests-command");
      ipcMain.handle("scope:pull-requests-command", () => {
        throw new Error("Synthetic failed inbox read");
      });
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected");
    });
    await page.getByRole("alert").filter({ hasText: "Synthetic failed inbox read" }).waitFor();
    await frame.locator("#ordinary").click();
    await opened("https://github.com/synthetic/private/pull/1");
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler("scope:pull-requests-command");
      ipcMain.handle("scope:pull-requests-command", () => new Promise(() => {}));
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected");
    });
    await frame.locator("#blank").click();
    await opened("https://github.com/synthetic/private/pull/2");

    for (const url of [
      "file:///tmp/example",
      "javascript:alert(1)",
      "https://user:secret@github.com/",
      "invalid",
    ]) {
      const failure = await frame.locator("body").evaluate(async (_body, url) => {
        const sdk = (
          window as unknown as {
            scope: { pullRequests: { openExternal: (url: string) => Promise<void> } };
          }
        ).scope.pullRequests;
        try {
          await sdk.openExternal(url);
          return "allowed";
        } catch (error) {
          return (error as Error).message;
        }
      }, url);
      expect(failure).not.toBe("allowed");
    }
    expect((await urls()).length).toBe(expected);
    const identity = await page.locator(".pull-requests-document").getAttribute("srcdoc");
    const channel = identity!.match(/"channel":"([^"]+)"/)![1];
    const forged = {
      channel,
      tabId,
      type: "scope-pull-requests-call",
      id: "forged",
      method: "openExternal",
      args: ["https://github.com/forged"],
    };
    await page.evaluate((call) => window.postMessage(call, "*"), forged);
    await frame
      .locator("body")
      .evaluate(
        (_body, call) => parent.postMessage({ ...call, channel: "wrong-channel" }, "*"),
        forged,
      );
    await frame
      .locator("body")
      .evaluate(
        (_body, call) => parent.postMessage({ ...call, tabId: crypto.randomUUID() }, "*"),
        forged,
      );
    await frame.locator("#ordinary").click();
    await opened("https://github.com/synthetic/private/pull/1");
    const mismatch = await page.evaluate(
      async ({ tabId }) => {
        try {
          await window.scope.openPullRequestsLink({
            name: "other-inbox",
            tabId,
            url: "https://github.com/",
          });
          return "allowed";
        } catch (error) {
          return (error as Error).message;
        }
      },
      { tabId },
    );
    expect(mismatch).toContain("another PR inbox");
    const wrongTab = await page.evaluate(async () => {
      try {
        await window.scope.openPullRequestsLink({
          name: "links-inbox",
          tabId: crypto.randomUUID(),
          url: "https://github.com/",
        });
        return "allowed";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(wrongTab).toContain("no longer open");
    const untrusted = await app.evaluate(async ({ BrowserWindow }, tabId) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${process.cwd()}/apps/desktop/dist/preload.cjs`,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await other.loadURL("data:text/html,Untrusted");
        return await other.webContents.executeJavaScript(
          `window.scope.openPullRequestsLink(${JSON.stringify({ name: "links-inbox", tabId, url: "https://github.com/" })}).then(()=>"allowed",error=>error.message)`,
        );
      } finally {
        other.destroy();
      }
    }, tabId);
    expect(untrusted).toContain("Untrusted IPC caller");
    expect((await urls()).length).toBe(expected);

    await app.evaluate(() => {
      (globalThis as unknown as { externalLinksTest: { fail: boolean } }).externalLinksTest.fail =
        true;
    });
    await frame.locator("#ordinary").click();
    await page.getByRole("alert").filter({ hasText: "Could not open the browser" }).waitFor();
    expect(
      await page.getByRole("alert").filter({ hasText: "Could not open the browser" }).textContent(),
    ).not.toContain("scope:open-pull-requests-link");
    await expect
      .poll(() => frame.locator("body").getAttribute("data-failure"))
      .toContain("Synthetic browser launch failure");
    await app.evaluate(() => {
      (globalThis as unknown as { externalLinksTest: { fail: boolean } }).externalLinksTest.fail =
        false;
    });
    await frame.locator("#ordinary").click();
    await opened("https://github.com/synthetic/private/pull/1");
    await expect
      .poll(() => page.getByRole("alert").filter({ hasText: "Could not open the browser" }).count())
      .toBe(0);
    await frame.locator("#top").click({ noWaitAfter: true });
    await opened("https://github.com/synthetic/private/pull/3");
    expect(page.url()).toMatch(/^scope:\/\/app\//);
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});

test("PR inbox browser links work before any snapshot is available", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  try {
    await app.evaluate(({ ipcMain, shell }) => {
      ipcMain.removeHandler("scope:pull-requests-command");
      ipcMain.handle("scope:pull-requests-command", () => {
        throw new Error("Synthetic unavailable initial snapshot");
      });
      Object.assign(globalThis, { initialBrowserLinks: [] as string[] });
      shell.openExternal = async (url) => {
        (globalThis as unknown as { initialBrowserLinks: string[] }).initialBrowserLinks.push(url);
      };
    });
    const page = await app.firstWindow();
    await page.evaluate(
      async (html) =>
        window.scope.createPullRequests({
          name: "unloaded-links",
          title: "Unloaded links",
          html,
          repository: { owner: "synthetic", name: "private" },
        }),
      html,
    );
    const frame = page.frameLocator(".pull-requests-document");
    await frame.locator("#ordinary").waitFor();
    await page
      .getByRole("alert")
      .filter({ hasText: "Synthetic unavailable initial snapshot" })
      .waitFor();
    await frame.locator("#ordinary").click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { initialBrowserLinks: string[] }).initialBrowserLinks,
        ),
      )
      .toEqual(["https://github.com/synthetic/private/pull/1"]);
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});

test("generic HTML keeps embedded navigation and window.open", async () => {
  const fixture = await desktopFixture();
  const app = await fixture.launch();
  try {
    const client = await fixture.connect();
    await client.publish(
      "generic-links",
      {
        title: "Generic links",
        kind: "html",
        mediaType: "text/html",
        fileName: "generic.html",
        expectedRevision: 0,
      },
      Buffer.from(
        '<a href="data:text/html,Embedded destination" target="_self">Embedded link</a><script>window.genericOpen = window.open;</script>',
      ),
    );
    const page = await app.firstWindow();
    const frame = page.frameLocator(".html-preview");
    await frame.getByRole("link", { name: "Embedded link" }).waitFor();
    expect(
      await frame.locator("body").evaluate(() => window.open.toString().includes("[native code]")),
    ).toBe(true);
    expect(
      await frame.locator("body").evaluate(() => window.open("about:blank", "_blank") !== null),
    ).toBe(true);
    await expect.poll(() => app.windows().length).toBe(2);
    await app.windows()[1]!.close();
    await frame.getByRole("link", { name: "Embedded link" }).click();
    await frame.getByText("Embedded destination", { exact: true }).waitFor();
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an inbox link canceled at the host keeps a connected diagram agent until actual navigation", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  try {
    const client = await fixture.connect();
    await client.publish(
      "kept-agent",
      {
        title: "Kept agent",
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: "diagram.excalidraw",
        expectedRevision: 0,
      },
      Buffer.from(JSON.stringify(nativeDiagram(1))),
    );
    const page = await app.firstWindow();
    await page.getByTestId("main-menu-trigger").waitFor();
    const waiting = client.diagramAgent({
      action: "wait",
      id: "kept-agent",
      name: "Still connected",
    });
    void waiting.catch(() => {});
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.scope.diagramAgentStatus("kept-agent")).phase),
      )
      .toBe("waiting");
    await app.evaluate(({ shell }) => {
      Object.assign(globalThis, { keptAgentLinks: [] as string[] });
      shell.openExternal = async (url) => {
        (globalThis as unknown as { keptAgentLinks: string[] }).keptAgentLinks.push(url);
      };
    });
    await page.evaluate(
      async (html) =>
        window.scope.createPullRequests({
          name: "kept-agent-inbox",
          title: "Agent inbox",
          html,
          repository: { owner: "synthetic", name: "private" },
        }),
      html,
    );
    await page.getByRole("tab", { name: "Agent inbox", exact: true }).click();
    const frame = page.frameLocator(".pull-requests-document");
    await frame.locator("#top").click({ noWaitAfter: true });
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { keptAgentLinks: string[] }).keptAgentLinks.length,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(async () => (await window.scope.diagramAgentStatus("kept-agent")).phase),
    ).toBe("waiting");
    await page.reload();
    await expect(waiting).rejects.toThrow();
    expect(
      await page.evaluate(async () => (await window.scope.diagramAgentStatus("kept-agent")).phase),
    ).toBe("disconnected");
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});
