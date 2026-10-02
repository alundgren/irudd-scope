import { expect, test } from "vite-plus/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("HTML presentation preserves page interactions and follows accessible frame documents", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>External destination</h1><button>External button</button>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing page server port.");
  const fixture = await desktopFixture();
  let application: Awaited<ReturnType<typeof fixture.launch>> | undefined;
  try {
    application = await fixture.launch();
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const html = join(fixture.directory, "presentation.html");
    await writeFile(
      html,
      `<!doctype html><html><body style="min-height:2000px">
      <h1>Presentation page</h1><button id="count">Count 0</button>
      <label>Draft <textarea></textarea></label><div id="shadow-draft"></div><button id="shadow-dialog">Open shadow dialog</button>
      <button id="dialog">Open dialog</button><dialog><form method="dialog"><button>Close dialog</button></form></dialog>
      <button id="nested-dialog">Open nested dialog</button>
      <dialog id="parent-dialog"><iframe title="Dialog page" srcdoc="&lt;button&gt;Dialog child button&lt;/button&gt;"></iframe><form method="dialog"><button>Close parent dialog</button></form></dialog>
      <button id="nested">Add nested frame</button><button id="handled">Handle Escape</button>
      <a href="http://127.0.0.1:${address.port}/">Navigate away</a>
      <script>
        const shadow = document.querySelector('#shadow-draft').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<textarea aria-label="Shadow draft"></textarea><dialog><form method="dialog"><button>Close shadow dialog</button></form></dialog>';
        document.querySelector('#shadow-dialog').onclick = () => shadow.querySelector('dialog').showModal();
        let count = 0;
        document.querySelector('#count').onclick = event => event.target.textContent = 'Count ' + ++count;
        document.querySelector('#dialog').onclick = () => document.querySelector('dialog').showModal();
        document.querySelector('#nested-dialog').onclick = () => document.querySelector('#parent-dialog').showModal();
        document.querySelector('#nested').onclick = () => {
          const frame = document.createElement('iframe'); frame.title = 'Nested page';
          frame.srcdoc = '<button onclick="this.textContent=this.dataset.result" data-result="Nested clicked">Nested button</button>';
          document.querySelector('#nested').after(frame);
        };
        document.querySelector('#handled').onkeydown = event => { if (event.key === 'Escape') event.preventDefault(); };
      </script></body></html>`,
    );
    await fixture.cli("add", html, "--id", "html-presentation", "--title", "HTML presentation");
    const frame = page.frameLocator('iframe[title="HTML presentation"]');
    await frame.getByRole("heading", { name: "Presentation page" }).waitFor();
    const mounted = await page.locator('iframe[title="HTML presentation"]').elementHandle();
    await frame.getByLabel("Draft", { exact: true }).fill("Keep this text");
    // Workspace shortcuts still work while the authored page has keyboard focus.
    await page.keyboard.press("ControlOrMeta+Shift+f");
    const mode = page.getByRole("combobox", { name: "Fullscreen HTML mode" });
    await expect.poll(() => mode.inputValue()).toBe("view");
    await mode.selectOption("present");
    await frame.getByRole("button", { name: "Count 0" }).click();
    await frame.getByRole("button", { name: "Count 1" }).waitFor();
    await expect
      .poll(() => frame.getByLabel("Draft", { exact: true }).inputValue())
      .toBe("Keep this text");
    const button = await frame.getByRole("button", { name: "Count 1" }).boundingBox();
    const point = { x: button!.x + 12, y: button!.y + 10 };
    await page.mouse.move(point.x, point.y);
    await expect
      .poll(() =>
        page.locator(".presentation-pointer").evaluate((element) => element.style.opacity),
      )
      .toBe("1");
    const tip = await page.locator(".presentation-pointer-tip").boundingBox();
    expect(tip!.x + tip!.width / 2).toBeCloseTo(point.x, 0);
    expect(tip!.y + tip!.height / 2).toBeCloseTo(point.y, 0);
    expect(
      await frame.locator("body").evaluate((element) => getComputedStyle(element).cursor),
    ).toBe("none");

    await frame.getByRole("button", { name: "Add nested frame" }).click();
    const nested = frame.frameLocator('iframe[title="Nested page"]');
    await nested.getByRole("button", { name: "Nested button" }).click();
    await nested.getByRole("button", { name: "Nested clicked" }).waitFor();
    const nestedBounds = await nested.getByRole("button").boundingBox();
    await page.mouse.move(nestedBounds!.x + 10, nestedBounds!.y + 10);
    await expect
      .poll(async () => {
        const bounds = await page.locator(".presentation-pointer-tip").boundingBox();
        return Math.abs(bounds!.x + bounds!.width / 2 - nestedBounds!.x - 10);
      })
      .toBeLessThan(1);
    await page.keyboard.press("Escape");
    await expect.poll(() => mode.inputValue()).toBe("view");
    expect(
      await nested.locator("body").evaluate((element) => getComputedStyle(element).cursor),
    ).not.toBe("none");
    await mode.selectOption("present");
    await frame.getByRole("button", { name: "Open dialog" }).click();
    await frame.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await frame.getByRole("dialog").waitFor({ state: "hidden" });
    expect(await mode.inputValue()).toBe("present");
    await frame.getByLabel("Draft", { exact: true }).focus();
    await page.keyboard.press("Escape");
    expect(await mode.inputValue()).toBe("present");
    await frame.getByLabel("Shadow draft").fill("Keep editing");
    await page.keyboard.press("Escape");
    expect(await mode.inputValue()).toBe("present");
    expect(await frame.getByLabel("Shadow draft").inputValue()).toBe("Keep editing");
    await frame.getByRole("button", { name: "Open shadow dialog" }).click();
    await frame.getByRole("button", { name: "Close shadow dialog" }).focus();
    await page.keyboard.press("Escape");
    await frame.getByRole("button", { name: "Close shadow dialog" }).waitFor({ state: "hidden" });
    expect(await mode.inputValue()).toBe("present");
    await frame.getByRole("button", { name: "Handle Escape" }).focus();
    await page.keyboard.press("Escape");
    expect(await mode.inputValue()).toBe("present");
    await frame.getByRole("button", { name: "Open nested dialog" }).click();
    await frame.frameLocator('iframe[title="Dialog page"]').getByRole("button").focus();
    await page.keyboard.press("Escape");
    expect(await mode.inputValue()).toBe("present");
    await frame.getByRole("button", { name: "Close parent dialog" }).click();
    await frame.locator("#parent-dialog").waitFor({ state: "hidden" });
    await frame.locator("body").evaluate((element) => {
      const handler = (event: KeyboardEvent) => {
        if (event.key === "Escape") event.preventDefault();
      };
      element.ownerDocument.defaultView!.addEventListener("keydown", handler, { once: true });
    });
    await frame.getByRole("button", { name: "Count 1" }).focus();
    await page.keyboard.press("Escape");
    expect(await mode.inputValue()).toBe("present");
    await frame.getByRole("button", { name: "Count 1" }).click();
    await page.mouse.wheel(0, 200);
    await expect
      .poll(() =>
        frame.locator("body").evaluate((element) => element.ownerDocument.defaultView!.scrollY),
      )
      .toBeGreaterThan(0);
    const scrolled = await frame
      .locator("body")
      .evaluate((element) => element.ownerDocument.defaultView!.scrollY);
    await mode.selectOption("view");
    expect(
      await frame.locator("body").evaluate((element) => element.ownerDocument.defaultView!.scrollY),
    ).toBe(scrolled);
    expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);

    await mode.selectOption("present");
    await frame.getByRole("link", { name: "Navigate away" }).click();
    await frame.getByRole("heading", { name: "External destination" }).waitFor();
    await frame.getByRole("button", { name: "External button" }).hover();
    await expect
      .poll(() =>
        page.locator(".presentation-pointer").evaluate((element) => element.style.opacity),
      )
      .toBe("0");
    expect(
      await frame.locator("body").evaluate((element) => getComputedStyle(element).cursor),
    ).not.toBe("none");
    await mode.selectOption("tabs");
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);
    expect(errors).toEqual([]);

    await fixture.cli(
      "add",
      html,
      "--plan",
      "--name",
      "presentable-plan",
      "--title",
      "Presentable plan",
    );
    await page.getByRole("tab", { name: "Presentable plan", exact: true }).click();
    const plan = page.frameLocator('iframe[title="Presentable plan"]');
    await plan.getByRole("button", { name: "Count 0" }).click();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await mode.selectOption("present");
    expect(await page.getByRole("button", { name: "Comment", exact: true }).count()).toBe(0);
    await plan.getByRole("button", { name: "Count 1" }).click();
    await plan.getByRole("button", { name: "Count 2" }).waitFor();
    const evidence = "/tmp/scope-html-presentation-evidence";
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "plan-present.png") });
    await page.keyboard.press("Escape");
    await expect.poll(() => mode.inputValue()).toBe("view");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
    await plan.getByRole("button", { name: "Count 2" }).waitFor();
  } finally {
    await application?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 90_000);
