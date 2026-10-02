import { expect, test } from "vite-plus/test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test.each(["html", "plan"])(
  "%s links open externally and preserve the authored page",
  async (kind) => {
    const fixture = await desktopFixture();
    const app = await fixture.launch();
    try {
      await app.evaluate(({ shell }) => {
        const state = { urls: [] as string[], fail: false, attempts: 0 };
        Object.assign(globalThis, { browserLinks: state });
        shell.openExternal = async (url) => {
          state.attempts++;
          if (state.fail) throw new Error("Synthetic browser launch failure");
          state.urls.push(url);
        };
      });
      const file = join(fixture.directory, "links.html");
      await writeFile(
        file,
        `<!doctype html><html><body>
      <input aria-label="Draft">
      <a href="https://example.com/ordinary">Ordinary link</a>
      <a href="https://example.com/blank" target="_blank" rel="noreferrer">New window</a>
      <a href="https://example.com/top" target="_top">Top window</a>
      <a href="https://example.com/stopped" onclick="event.stopPropagation()">Stopped propagation</a>
      <a href="https://example.com/cancelled" onclick="event.preventDefault()">Cancelled link</a>
      <a href="#section">Jump</a><div id="section">Same document</div>
      <button onclick="window.open('https://example.com/scripted')">Scripted window</button>
      <iframe title="Nested links" srcdoc="&lt;a href='https://example.com/nested'&gt;Nested link&lt;/a&gt;"></iframe>
    </body></html>`,
      );
      await fixture.cli(
        "add",
        file,
        "--title",
        "Browser links",
        ...(kind === "plan" ? ["--plan", "--name", "browser-plan"] : []),
      );
      const page = await app.firstWindow();
      page.setDefaultTimeout(5_000);
      const frame = page.frameLocator('iframe[title="Browser links"]');
      await frame.getByLabel("Draft").fill("Keep this draft");
      const urls = () =>
        app.evaluate(
          () => (globalThis as unknown as { browserLinks: { urls: string[] } }).browserLinks.urls,
        );
      const expected: string[] = [];
      async function opened(path: string) {
        expected.push(`https://example.com/${path}`);
        await expect.poll(urls).toEqual(expected);
        await expect.poll(() => app.windows().length).toBe(1);
        expect(await frame.getByLabel("Draft").inputValue()).toBe("Keep this draft");
        expect(page.url()).toBe("scope://app/index.html");
      }
      await frame
        .getByRole("link", { name: "Ordinary link", exact: true })
        .click({ noWaitAfter: true });
      await opened("ordinary");
      await frame
        .getByRole("link", { name: "New window", exact: true })
        .click({ noWaitAfter: true });
      await opened("blank");
      for (const modifiers of [["Control"], ["Meta"], ["Shift"]] as const) {
        await frame
          .getByRole("link", { name: "Ordinary link", exact: true })
          .click({ modifiers: [...modifiers] });
        await opened("ordinary");
      }
      await frame
        .getByRole("link", { name: "Ordinary link", exact: true })
        .click({ button: "middle", noWaitAfter: true });
      await opened("ordinary");
      await frame.getByRole("link", { name: "Ordinary link", exact: true }).focus();
      await page.keyboard.press("Enter");
      await opened("ordinary");
      await frame.getByRole("button", { name: "Scripted window" }).click({ noWaitAfter: true });
      await opened("scripted");
      await frame
        .frameLocator('iframe[title="Nested links"]')
        .getByRole("link")
        .click({ noWaitAfter: true });
      await opened("nested");
      await frame.getByRole("link", { name: "Stopped propagation" }).click({ noWaitAfter: true });
      await opened("stopped");
      await frame.getByRole("link", { name: "Cancelled link" }).click({ noWaitAfter: true });
      await frame.getByRole("link", { name: "Jump", exact: true }).click({ noWaitAfter: true });
      await expect.poll(() => frame.locator("body").evaluate(() => location.hash)).toBe("#section");
      expect(await urls()).toEqual(expected);
      await app.evaluate(() => {
        (globalThis as unknown as { browserLinks: { fail: boolean } }).browserLinks.fail = true;
      });
      await frame
        .getByRole("link", { name: "Ordinary link", exact: true })
        .click({ noWaitAfter: true });
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { browserLinks: { attempts: number } }).browserLinks
                .attempts,
          ),
        )
        .toBe(expected.length + 1);
      expect(await frame.getByLabel("Draft").inputValue()).toBe("Keep this draft");
      expect(await urls()).toEqual(expected);
      await app.evaluate(() => {
        (globalThis as unknown as { browserLinks: { fail: boolean } }).browserLinks.fail = false;
      });
      await frame
        .getByRole("link", { name: "Top window", exact: true })
        .click({ noWaitAfter: true });
      await opened("top");
    } finally {
      await app.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
  60_000,
);
