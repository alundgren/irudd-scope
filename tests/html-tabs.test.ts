import { expect, test } from "vite-plus/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("published HTML runs a complete prototype with external resources, forms, and popups", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(request.url!, "http://localhost");
    switch (url.pathname) {
      case "/prototype.css":
        response.setHeader("Content-Type", "text/css");
        response.end("h1 { color: rgb(30, 80, 120); }");
        break;
      case "/prototype.js":
        response.setHeader("Content-Type", "text/javascript");
        response.end(`
          const result = await fetch(new URL('./data', import.meta.url)).then(r => r.text());
          document.querySelector('#result').textContent = result;
          document.querySelector('#count').onclick = () => {
            const count = Number(localStorage.getItem('prototype-count') || '0') + 1;
            localStorage.setItem('prototype-count', String(count));
            document.querySelector('#count').textContent = 'Count ' + count;
          };
          document.querySelector('#popup').onclick = () => window.open('./popup', 'prototype-popup');
          document.querySelector('#copy').onclick = async () => {
            await navigator.clipboard.writeText('Prototype clipboard');
            document.querySelector('#copy').textContent = 'Copied';
          };
          document.body.dataset.evaluated = new Function('return 6 * 7')();
        `);
        break;
      case "/data":
        response.end("Loaded prototype data");
        break;
      case "/image.svg":
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>',
        );
        break;
      case "/form":
        response.setHeader("Content-Type", "text/html");
        response.end(`<h1>Submitted ${url.searchParams.get("name")}</h1>`);
        break;
      default:
        response.setHeader("Content-Type", "text/html");
        response.end(`<h1>${url.pathname === "/popup" ? "Prototype popup" : "Linked page"}</h1>`);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing prototype server port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const { directory, launch, cli } = await desktopFixture();
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const file = join(directory, "prototype.html");
    await writeFile(
      file,
      `<!doctype html>
      <html><head>
        <meta charset="utf-8"><title>Prototype document</title>
        <base href="${origin}/">
        <link rel="stylesheet" href="prototype.css">
        <script type="module" src="prototype.js"></script>
      </head><body>
        <h1>Interactive prototype</h1>
        <p id="result">Loading</p>
        <img src="image.svg" alt="External image">
        <button id="count">Count 0</button>
        <button id="popup">Open popup</button>
        <button id="copy">Copy text</button>
        <a href="data:text/plain,Prototype%20export" download="prototype.txt">Export prototype</a>
        <form action="form" target="form-result">
          <label>Name <input name="name"></label><button>Submit</button>
        </form>
        <iframe name="form-result" title="Form result"></iframe>
        <a href="linked">Follow link</a>
        <script>document.body.dataset.inline = 'ran';</script>
      </body></html>`,
    );
    await cli("add", file, "--id", "prototype", "--title", "Prototype");
    const preview = page.frameLocator('iframe[title="Prototype"]');
    await preview.getByText("Loaded prototype data", { exact: true }).waitFor();
    expect(await preview.locator("body").getAttribute("data-inline")).toBe("ran");
    expect(await preview.locator("body").getAttribute("data-evaluated")).toBe("42");
    expect(
      await preview.locator("html").evaluate((element) => element.ownerDocument.compatMode),
    ).toBe("CSS1Compat");
    expect(await preview.locator("title").textContent()).toBe("Prototype document");
    expect(
      await preview.getByRole("heading").evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(30, 80, 120)");
    await expect
      .poll(() =>
        preview.getByRole("img").evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBe(40);
    await preview.getByRole("button", { name: "Count 0" }).click();
    await preview.getByRole("button", { name: "Count 1" }).waitFor();
    await preview.getByLabel("Name", { exact: true }).fill("Ada");
    await preview.getByRole("button", { name: "Submit", exact: true }).click();
    await preview
      .frameLocator('iframe[title="Form result"]')
      .getByRole("heading", { name: "Submitted Ada" })
      .waitFor();
    const popupPromise = page.waitForEvent("popup");
    await preview.getByRole("button", { name: "Open popup" }).click();
    const popup = await popupPromise;
    await popup.getByRole("heading", { name: "Prototype popup" }).waitFor();
    await popup.close();
    await preview.getByRole("button", { name: "Copy text" }).click();
    await preview.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const download = join(directory, "prototype.txt");
    await application.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) => item.setSavePath(path));
    }, download);
    await preview.getByRole("link", { name: "Export prototype" }).click();
    await expect.poll(() => readFile(download, "utf8")).toBe("Prototype export");

    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await page.getByRole("button", { name: "Exit focus mode" }).waitFor();
    await preview.getByRole("button", { name: "Count 1" }).click();
    await preview.getByRole("button", { name: "Count 2" }).waitFor();
    await page.getByRole("button", { name: "Exit focus mode" }).click();
    await preview.getByRole("button", { name: "Count 2" }).waitFor();

    await preview.getByRole("link", { name: "Follow link" }).click();
    await preview.getByRole("heading", { name: "Linked page" }).waitFor();
    expect(await page.getByRole("button", { name: "Search and controls" }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
