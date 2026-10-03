import { expect, test } from "vite-plus/test";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { LocalDatabase, type Draft } from "../apps/plan-web/src/browser/local-database.ts";
import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPlanWebServer } from "../apps/plan-web/src/backend/server.ts";
import type { Actor, CommandReceipt, PlanSnapshot } from "../apps/plan-web/src/contracts.ts";

const { PGlite } = createRequire(new URL("../apps/plan-web/package.json", import.meta.url))(
  "@electric-sql/pglite",
) as {
  PGlite: {
    create(options: {
      dataDir: string;
      relaxedDurability: boolean;
    }): Promise<ConstructorParameters<typeof LocalDatabase>[0]>;
  };
};
const actor = (name: string, kind: Actor["kind"] = "agent"): Actor => ({ id: name, name, kind });
const html = (agents = 6) => `<!doctype html><html><head><title>Shared planning</title></head><body>
<h1 id="heading">Launch plan</h1>
<p id="human-0">Human0-000</p>
<p id="human-1">Human1-000</p>
${Array.from({ length: agents }, (_, i) => `<p id="agent-${i}">Agent${i}-000</p>`).join("\n")}
<section id="decision"><h2>Decision</h2><p>Keep every accepted edit.</p></section>
</body></html>`;

async function fixture(name: string, agents = 6, activePlayers = false) {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-web-browser-"));
  const setupCleanup: (() => Promise<unknown>)[] = [];
  try {
    const databasePath = join(directory, "plans.db");
    const assetsDirectory = resolve("apps/plan-web/dist/client");
    let server = await startPlanWebServer({ databasePath, assetsDirectory, port: 0 });
    setupCleanup.push(() => server.close());
    let eventsBlocked = false;
    let blockedEvents = 0;
    const eventConnections = new Map<ServerResponse, ClientRequest>();
    const gateway = createServer((incoming, outgoing) => {
      const events = incoming.url?.startsWith("/api/events?") ?? false;
      if (events && eventsBlocked) {
        blockedEvents++;
        outgoing.writeHead(503).end("Stream deliberately unavailable in this test.");
        return;
      }
      const forwarded = httpRequest(
        new URL(incoming.url ?? "/", server.url),
        {
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          if (outgoing.destroyed) {
            response.destroy();
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.on("error", () => outgoing.destroy());
          response.on("aborted", () => outgoing.destroy());
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.on("close", () => {
        forwarded.destroy();
        eventConnections.delete(outgoing);
      });
      if (events) eventConnections.set(outgoing, forwarded);
      incoming.pipe(forwarded);
    });
    setupCleanup.push(async () => {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(0, "127.0.0.1", resolve);
    });
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === "string")
      throw new Error("Missing test gateway address.");
    const browserUrl = `http://127.0.0.1:${gatewayAddress.port}`;
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--no-proxy-server",
        "--host-resolver-rules=MAP scope.local 127.0.0.1",
        ...(activePlayers
          ? [
              "--disable-background-timer-throttling",
              "--disable-renderer-backgrounding",
              "--disable-backgrounding-occluded-windows",
            ]
          : []),
      ],
    });
    setupCleanup.push(() => browser.close());
    const api = () => `${server.url}/api/plans/${name}`;
    const snapshot = async (): Promise<PlanSnapshot> => {
      const response = await fetch(api());
      expect(response.status).toBe(200);
      return response.json() as Promise<PlanSnapshot>;
    };
    const command = async (input: object) => {
      const response = await fetch(`${api()}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: (await response.json()) as CommandReceipt };
    };
    const original = await snapshot();
    expect(
      (
        await command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Seeder"),
          baseHtmlRevision: original.htmlRevision,
          html: html(agents),
        })
      ).status,
    ).toBe(200);
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    const errors: string[] = [];
    const requests: object[] = [];
    return {
      api,
      snapshot,
      command,
      browser,
      address: () => browserUrl,
      blockEvents() {
        eventsBlocked = true;
        for (const [response, request] of eventConnections) {
          request.destroy();
          response.destroy();
        }
      },
      unblockEvents() {
        eventsBlocked = false;
      },
      blockedEvents: () => blockedEvents,
      async context() {
        const context = await browser.newContext();
        contexts.push(context);
        return context;
      },
      async page(context: BrowserContext, displayName: string, planName = name) {
        const page = await context.newPage();
        pages.push(page);
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.url().endsWith("/commands"))
            requests.push({ page: displayName, at: Date.now(), command: request.postData() });
        });
        page.on("response", (response) => {
          if (response.url().endsWith("/commands"))
            requests.push({ page: displayName, at: Date.now(), status: response.status() });
        });
        await page.goto(`${browserUrl}/plans/${planName}`);
        await visible(page, "human-0", "Human0-000");
        await expect
          .poll(() => page.locator("#comment-mode").isEnabled(), { timeout: 30_000 })
          .toBe(true);
        await page.getByRole("combobox", { name: "User", exact: true }).selectOption({
          label: ["Alex", "Blair", "Casey"].includes(displayName) ? displayName : "Alex",
        });
        return page;
      },
      async restart() {
        const port = Number(new URL(server.url).port);
        await server.close();
        server = await startPlanWebServer({ databasePath, assetsDirectory, port });
      },
      async evidence() {
        const details = [];
        for (const [index, page] of pages.entries()) {
          if (page.isClosed()) continue;
          const screenshot = `/tmp/scope-web-${name}-${index}.png`;
          await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
          details.push({
            screenshot,
            visibility: await page.evaluate(() => document.visibilityState),
            status: await page
              .locator("#sync-status")
              .textContent()
              .catch(() => "missing"),
            preview: await page.locator("iframe").getAttribute("srcdoc"),
          });
        }
        await writeFile(
          `/tmp/scope-web-${name}-evidence.json`,
          JSON.stringify({ details, errors, requests, server: await snapshot() }, null, 2),
        );
        console.error(
          `Browser failure evidence: /tmp/scope-web-${name}-evidence.json`,
          details.map((item) => ({
            screenshot: item.screenshot,
            status: item.status,
          })),
          errors,
        );
      },
      async close() {
        await Promise.all(contexts.map((context) => context.close()));
        await browser.close();
        await server.close();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const close of setupCleanup.reverse()) await close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function visible(page: Page, id: string, expected: string) {
  await expect
    .poll(() => page.frameLocator('iframe[title="Plan preview"]').locator(`#${id}`).textContent(), {
      timeout: 20_000,
    })
    .toBe(expected);
}
async function add(page: Page, text: string, selector = "#heading") {
  await page.bringToFront();
  await page.locator("#comment-mode").click();
  await page.frameLocator("iframe").locator(selector).click();
  expect(
    await page.locator("#comment-text").evaluate((input) => document.activeElement === input),
  ).toBe(true);
  await page.locator("#comment-text").fill(text);
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect
    .poll(() => page.locator("#comment-composer").isVisible(), { timeout: 20_000 })
    .toBe(false);
}
async function menu(page: Page, id: string) {
  await page.locator("#plan-menu summary").click();
  await page.locator(id).click();
}
async function agentEdit(
  f: Awaited<ReturnType<typeof fixture>>,
  before: string,
  after: string,
  name = "Agent",
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const snapshot = await f.snapshot();
    const command = {
      kind: "html",
      requestId: randomUUID(),
      actor: actor(name),
      baseHtmlRevision: snapshot.htmlRevision,
      html: snapshot.html.replace(before, after),
    };
    const result = await f.command(command);
    if (result.status === 409) continue;
    expect(result.status).toBe(200);
    expect((await f.command(command)).body).toEqual(result.body);
    return;
  }
  throw new Error("Agent could not commit its update.");
}
async function withFixture(
  name: string,
  work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  agents = 1,
) {
  const f = await fixture(name, agents, true);
  try {
    await work(f);
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}

test("three readers comment while six API agents edit, replay duplicate requests and restart", async () => {
  await withFixture(
    "reader-pressure",
    async (f) => {
      const readers = await Promise.all(
        ["Alex", "Blair", "Casey"].map(async (name) => f.page(await f.context(), name)),
      );
      for (let round = 0; round < 3; round++) {
        await Promise.all([
          ...readers.map((page, index) => add(page, `Reader ${index} round ${round}`)),
          ...Array.from({ length: 6 }, (_, i) =>
            agentEdit(
              f,
              `Agent${i}-${round === 0 ? "000" : round - 1}`,
              `Agent${i}-${round}`,
              `Agent ${i}`,
            ),
          ),
        ]);
        if (round === 1) await f.restart();
      }
      await expect
        .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
        .toBe(9);
      for (const page of readers) {
        for (let i = 0; i < 6; i++) await visible(page, `agent-${i}`, `Agent${i}-2`);
        for (let i = 0; i < 3; i++)
          await page.getByText(`Reader ${i} round 2`, { exact: true }).waitFor();
        expect(await page.locator("#source,#save,#merge-html").count()).toBe(0);
      }
      const snapshot = await f.snapshot();
      expect(snapshot.comments.map((c) => c.actor.name).sort()).toEqual([
        "Alex",
        "Alex",
        "Alex",
        "Blair",
        "Blair",
        "Blair",
        "Casey",
        "Casey",
        "Casey",
      ]);
      expect(snapshot.htmlRevision).toBe(20);
    },
    6,
  );
}, 180_000);

test("comments panel toggles and returns its width to the HTML; history is read-only", async () => {
  await withFixture("reader-layout", async (f) => {
    const page = await f.page(await f.context(), "Alex");
    const width = () =>
      page.locator("iframe").evaluate((frame) => frame.getBoundingClientRect().width);
    const full = await width();
    await page.locator("#comments-button").click();
    expect(await width()).toBeLessThan(full - 250);
    await page.locator("#comments-button").click();
    expect(await width()).toBe(full);
    await agentEdit(f, "Human0-000", "Human0-agent");
    await visible(page, "human-0", "Human0-agent");
    await menu(page, "#history-button");
    await page.getByRole("button", { name: /html · Seeder/ }).click();
    await visible(page, "human-0", "Human0-000");
    expect(await page.locator("#comment-mode").isEnabled()).toBe(false);
    await page.locator("#return-live").click();
    await visible(page, "human-0", "Human0-agent");
    expect(await page.locator("#comment-mode").isEnabled()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#close-panel").click();
    expect(
      await page.locator("iframe").evaluate((frame) => frame.getBoundingClientRect().width),
    ).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });
}, 90_000);

test("offline comment and reply queues survive reload, owner closure and server catch-up", async () => {
  await withFixture("reader-offline", async (f) => {
    const context = await f.context();
    const owner = await f.page(context, "Alex");
    const survivor = await f.page(context, "Blair");
    await add(owner, "Existing discussion");
    await expect.poll(async () => (await f.snapshot()).comments.length).toBe(1);
    await context.route("**/api/plans/**/commands", (route) => route.abort());
    await add(owner, "Offline owner comment");
    const article = owner.locator(".comment").filter({ hasText: "Existing discussion" });
    await article.getByRole("textbox", { name: "Reply text" }).fill("Offline reply");
    await article.getByRole("button", { name: "Reply", exact: true }).click();
    await expect
      .poll(() => article.getByRole("textbox", { name: "Reply text" }).inputValue())
      .toBe("");
    await article.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect.poll(() => owner.locator("#sync-status").textContent()).toContain("Saved locally");
    await owner.reload();
    await expect.poll(() => owner.locator("#sync-status").textContent()).toContain("Saved locally");
    await owner.close();
    await agentEdit(f, "Human0-000", "Human0-remote");
    await context.unroute("**/api/plans/**/commands");
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
      .toBe(2);
    await expect
      .poll(async () => (await f.snapshot()).comments[0].replies.map((r) => r.text), {
        timeout: 30_000,
      })
      .toEqual(["Offline reply"]);
    await expect
      .poll(async () => (await f.snapshot()).comments[0].resolved, { timeout: 30_000 })
      .toBe(true);
    const snapshot = await f.snapshot();
    expect(snapshot.comments[0].replies.map((r) => r.text)).toEqual(["Offline reply"]);
    expect(snapshot.comments[0].resolved).toBe(true);
    expect(snapshot.comments[1].actor.name).toBe("Alex");
    await survivor.locator("#comments-button").click();
    await survivor.getByText("Offline owner comment", { exact: true }).waitFor();
    await survivor.locator(".reply").filter({ hasText: "Offline reply" }).waitFor();
    await visible(survivor, "human-0", "Human0-remote");
    expect(snapshot.htmlRevision).toBe(3);
  });
}, 120_000);

test("lost accepted comment acknowledgement permits later comments and competing HTML", async () => {
  await withFixture("reader-lost-ack", async (f) => {
    const context = await f.context();
    const page = await f.page(context, "Alex");
    f.blockEvents();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted = false;
    await context.route("**/commands", async (route) => {
      if (route.request().postDataJSON().text === "First comment") {
        const response = await route.fetch();
        accepted = true;
        await held;
        await route.fulfill({ response }).catch(() => {});
      } else await route.continue();
    });
    const first = add(page, "First comment");
    await expect.poll(() => accepted).toBe(true);
    await first;
    await add(page, "Later comment");
    await agentEdit(f, "Human0-000", "Human0-agent");
    release();
    await first;
    f.unblockEvents();
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
      .toBe(2);
    expect((await f.snapshot()).comments.map((c) => c.text)).toEqual([
      "First comment",
      "Later comment",
    ]);
    await visible(page, "human-0", "Human0-agent");
  });
}, 120_000);

for (const status of [400, 413, 422])
  test(`rejected comment HTTP ${status} persists, can be edited and retried independently`, async () => {
    await withFixture(`reader-reject-${status}`, async (f) => {
      const context = await f.context();
      const page = await f.page(context, "Casey");
      const attempts: string[] = [];
      await context.route("**/commands", async (route) => {
        const command = route.request().postDataJSON();
        if (command.text === "Refused comment") {
          attempts.push(command.requestId);
          await route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({ error: "Deliberate refusal" }),
          });
        } else await route.continue();
      });
      await add(page, "Refused comment");
      await expect
        .poll(() => page.locator("#sync-status").textContent())
        .toContain("Rejected comment");
      await page.reload();
      await expect
        .poll(() => page.locator("#comment-mode").isEnabled(), { timeout: 30_000 })
        .toBe(true);
      await menu(page, "#rejections-button");
      await page.getByRole("textbox", { name: "Rejected comment text" }).waitFor();
      expect(await page.getByRole("textbox", { name: "Rejected comment text" }).inputValue()).toBe(
        "Refused comment",
      );
      await agentEdit(f, "Human0-000", "Human0-after-refusal");
      await add(page, "Valid comment");
      await menu(page, "#rejections-button");
      await page.getByRole("textbox", { name: "Rejected comment text" }).fill("Edited retry");
      await page.getByRole("button", { name: "Retry edited comment" }).click();
      await expect
        .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
        .toBe(2);
      expect(attempts).toHaveLength(1);
      await add(page, "Refused comment");
      await menu(page, "#rejections-button");
      await page.getByRole("button", { name: "Dismiss rejected change" }).click();
      await page.getByText("No rejected changes.", { exact: true }).waitFor();
      await visible(page, "human-0", "Human0-after-refusal");
    });
  }, 120_000);

test("selection, cancellation and comments preserve exact authored HTML and its revision for unique, missing, duplicate and script IDs", async () => {
  await withFixture("reader-anchor-bytes", async (f) => {
    const current = await f.snapshot();
    const scripted = current.html.replace(
      "</body>",
      `<p>No identifier</p><p id="duplicate">Duplicate one</p><p id="duplicate">Duplicate two</p>
<a href=/guide/>Unquoted URL</a><p id="script-source">Authored source</p>
<script>window.example = "<script><\\/script><p>Hello</p>";
const generated=document.createElement('p'); generated.id='generated'; generated.textContent='Generated element'; document.body.append(generated);
const copied=document.getElementById('script-source').cloneNode(true); copied.id='copied'; document.body.append(copied);</script></body>`,
    );
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Script author"),
          baseHtmlRevision: current.htmlRevision,
          html: scripted,
        })
      ).status,
    ).toBe(200);
    const accepted = await f.snapshot();
    const page = await f.page(await f.context(), "Alex");
    const cases = [
      { selector: "#heading", id: "heading" },
      { selector: 'p:text-is("No identifier")', id: null },
      { selector: 'p[id="duplicate"] >> nth=0', id: null },
      { selector: "a", id: null },
      { selector: "#generated", id: null },
      { selector: "#copied", id: null },
      { selector: "#script-source", id: null },
    ];
    for (const [index, item] of cases.entries()) {
      await page.locator("#comment-mode").click();
      await page.frameLocator("iframe").locator(item.selector).click();
      const selected = await f.snapshot();
      expect(selected.html).toBe(scripted);
      expect(selected.htmlRevision).toBe(accepted.htmlRevision);
      await page.locator("#cancel-comment").click();
      const canceled = await f.snapshot();
      expect(canceled.html).toBe(scripted);
      expect(canceled.htmlRevision).toBe(accepted.htmlRevision);
      await add(page, `Anchor ${index}`, item.selector);
      await expect.poll(async () => (await f.snapshot()).comments.length).toBe(index + 1);
      const submitted = await f.snapshot();
      expect(submitted.html).toBe(scripted);
      expect(submitted.htmlRevision).toBe(accepted.htmlRevision);
      expect(submitted.comments[index].anchor.elementId).toBe(item.id);
    }
    expect(
      await page
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() => (window as unknown as { example: string }).example),
    ).toBe("<script></script><p>Hello</p>");
    await page.reload();
    await visible(page, "heading", "Launch plan");
    expect((await f.snapshot()).html).toBe(scripted);
  });
}, 180_000);

test("anchors detach when agents remove identifiers and reconnect only to unique authored elements", async () => {
  await withFixture("reader-anchor-lifecycle", async (f) => {
    const page = await f.page(await f.context(), "Alex");
    await add(page, "Keep this decision", "#decision");
    const comment = page.locator(".comment").filter({ hasText: "Keep this decision" });
    await expect.poll(() => comment.locator(".comment-meta").textContent()).toContain("Connected");
    await agentEdit(f, 'id="decision"', 'id="retired"');
    await expect.poll(() => comment.locator(".comment-meta").textContent()).toContain("Detached");
    await agentEdit(f, 'id="retired"', 'id="decision"');
    await expect.poll(() => comment.locator(".comment-meta").textContent()).toContain("Connected");
    await agentEdit(f, "</body>", '<p id="decision">Ambiguous</p></body>');
    await expect.poll(() => comment.locator(".comment-meta").textContent()).toContain("Detached");
  });
}, 90_000);

test("durable comments recover after worker termination without submitting browser HTML", async () => {
  await withFixture("reader-worker-loss", async (f) => {
    const context = await f.context();
    const page = await f.page(context, "Alex");
    const witness = await f.page(context, "Blair");
    const sentKinds: string[] = [];
    context.on("request", (request) => {
      if (request.url().endsWith("/commands")) sentKinds.push(request.postDataJSON().kind);
    });
    await context.route("**/commands", (route) => route.abort());
    await add(page, "Durable before worker loss");
    const session = await f.browser.newBrowserCDPSession();
    try {
      const targets = await session.send("Target.getTargets");
      const worker = targets.targetInfos.find(
        (target: { type: string; url: string }) =>
          target.type === "shared_worker" && target.url.includes("database-worker"),
      );
      if (!worker) throw new Error("Missing database worker.");
      expect(
        (await session.send("Target.closeTarget", { targetId: worker.targetId })).success,
      ).toBe(true);
    } finally {
      await session.detach();
    }
    await page.reload();
    await expect
      .poll(() => page.locator("#comment-mode").isEnabled(), { timeout: 30_000 })
      .toBe(true);
    await context.unroute("**/commands");
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
      .toBe(1);
    await witness.reload();
    await witness.locator("#comments-button").click();
    await witness.getByText("Durable before worker loss", { exact: true }).waitFor();
    expect(sentKinds.every((kind) => kind === "comment.add")).toBe(true);
    expect((await f.snapshot()).htmlRevision).toBe(2);
  });
}, 120_000);

test("cached HTML stays visible while a new tab waits for comment storage readiness", async () => {
  await withFixture("reader-startup", async (f) => {
    const context = await f.context();
    await f.page(context, "Alex");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route("**/api/plans/reader-startup", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const page = await context.newPage();
    try {
      await page.goto(`${f.address()}/plans/reader-startup`);
      await visible(page, "human-0", "Human0-000");
      expect(await page.locator("#comment-mode").isEnabled()).toBe(false);
      expect(await page.locator("#source").count()).toBe(0);
    } finally {
      release();
    }
    await expect
      .poll(() => page.locator("#comment-mode").isEnabled(), { timeout: 30_000 })
      .toBe(true);
    await add(page, "Ready to discuss");
    await expect.poll(async () => (await f.snapshot()).comments.length).toBe(1);
  });
}, 120_000);

test("plain HTTP renders authored HTML and explains unavailable durable comments", async () => {
  await withFixture("reader-insecure", async (f) => {
    const context = await f.context();
    const page = await context.newPage();
    await page.goto(`${f.address().replace("127.0.0.1", "scope.local")}/plans/reader-insecure`);
    await visible(page, "human-0", "Human0-000");
    expect(await page.locator("#comment-mode").isEnabled()).toBe(false);
    await page
      .getByText("Comments need local storage. Any unsent text stays in its composer.", {
        exact: true,
      })
      .waitFor();
    await page.locator("#plan-menu summary").click();
    expect(await page.locator("#sync-status").textContent()).toContain("HTTPS or localhost");
  });
}, 90_000);

test("eight tabs on one plan keep comments and agent changes live", async () => {
  await withFixture("reader-eight-tabs", async (f) => {
    const context = await f.context();
    const pages: Page[] = [];
    for (let i = 0; i < 8; i++)
      pages.push(await f.page(context, ["Alex", "Blair", "Casey"][i % 3]));
    await add(pages[0], "Eight tabs can discuss");
    await agentEdit(f, "Human0-000", "Human0-eight-tabs");
    for (const page of pages) {
      await visible(page, "human-0", "Human0-eight-tabs");
      if (!(await page.locator("#discussion").isVisible()))
        await page.locator("#comments-button").click();
      await page.getByText("Eight tabs can discuss", { exact: true }).waitFor();
    }
    expect((await f.snapshot()).comments).toHaveLength(1);
  });
}, 180_000);

test("eight different plans share one browser stream and independently recover after interruption", async () => {
  await withFixture("reader-eight-plans", async (f) => {
    const names = Array.from({ length: 8 }, (_, i) => `reader-eight-plans-${i}`);
    const planApi = (name: string) => `${f.address()}/api/plans/${name}`;
    for (const name of names) {
      const snapshot = await (await fetch(planApi(name))).json();
      expect(
        (
          await fetch(`${planApi(name)}/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "html",
              requestId: randomUUID(),
              actor: actor("Seeder"),
              baseHtmlRevision: snapshot.htmlRevision,
              html: html(1),
            }),
          })
        ).status,
      ).toBe(200);
    }
    const context = await f.context();
    const pages: Page[] = [];
    for (const name of names) pages.push(await f.page(context, "Alex", name));
    f.blockEvents();
    for (const [i, name] of names.entries()) {
      const snapshot = await (await fetch(planApi(name))).json();
      expect(
        (
          await fetch(`${planApi(name)}/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "html",
              requestId: randomUUID(),
              actor: actor("Agent"),
              baseHtmlRevision: snapshot.htmlRevision,
              html: snapshot.html.replace("Human0-000", `Human0-plan-${i}`),
            }),
          })
        ).status,
      ).toBe(200);
    }
    f.unblockEvents();
    await Promise.all(pages.map((page, i) => visible(page, "human-0", `Human0-plan-${i}`)));
    await Promise.all(pages.map((page, i) => add(page, `Discussion ${i}`)));
    for (const [i, name] of names.entries())
      await expect
        .poll(
          async () =>
            (await (await fetch(planApi(name))).json()).comments.map(
              (c: { text: string }) => c.text,
            ),
          { timeout: 30_000 },
        )
        .toEqual([`Discussion ${i}`]);
  });
}, 240_000);

test("fake users are tab-local and queued comments retain captured authors after switching and reload", async () => {
  await withFixture("reader-fake-users", async (f) => {
    const context = await f.context();
    const alex = await f.page(context, "Alex");
    const blair = await f.page(context, "Blair");
    const casey = await f.page(context, "Casey");
    await context.route("**/commands", (route) => route.abort());
    await add(alex, "Queued by Alex");
    await alex.locator("#fake-user").selectOption({ label: "Casey" });
    await alex.reload();
    await expect
      .poll(() => alex.locator("#comment-mode").isEnabled(), { timeout: 30_000 })
      .toBe(true);
    expect(await alex.locator("#fake-user").inputValue()).toBe("fake-user-casey");
    expect(await blair.locator("#fake-user").inputValue()).toBe("fake-user-blair");
    expect(await casey.locator("#fake-user").inputValue()).toBe("fake-user-casey");
    await context.unroute("**/commands");
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
      .toBe(1);
    await add(alex, "New by Casey");
    await add(blair, "New by Blair");
    await add(casey, "Other Casey tab");
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
      .toBe(4);
    const snapshot = await f.snapshot();
    expect(snapshot.comments.map((c) => c.actor.name)).toEqual(["Alex", "Casey", "Blair", "Casey"]);
    await menu(alex, "#history-button");
    await alex.getByRole("button", { name: /comment.add · Alex/ }).waitFor();
    expect(snapshot.htmlRevision).toBe(2);
  });
}, 150_000);

test("legacy HTML drafts, conflicts, refusals and uncertain requests freeze before acceptance and remain exportable across database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-reader-archive-"));
  let db = await PGlite.create({ dataDir: directory, relaxedDurability: false });
  try {
    await LocalDatabase.initialize(db);
    const snapshot: PlanSnapshot = {
      name: "archived",
      html: "<p id='live'>Accepted</p>",
      revision: 4,
      htmlRevision: 3,
      comments: [],
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    const drafts: { editor: string; draft: Draft }[] = [
      {
        editor: "closed-owner",
        draft: {
          html: "<p>Unsent 🎈\nexact bytes</p>",
          baseHtml: "<p>Base</p>",
          baseHtmlRevision: 1,
          generation: 8,
          actor: actor("Alex", "human"),
          dirty: true,
          conflict: null,
        },
      },
      {
        editor: "conflicted-owner",
        draft: {
          html: "<!-- unresolved --><p>Local</p>",
          baseHtml: "<p>Original</p>",
          baseHtmlRevision: 2,
          generation: 11,
          actor: actor("Blair", "human"),
          dirty: true,
          conflict: snapshot,
          rejectedGeneration: 11,
        },
      },
    ];
    await db.query("INSERT INTO plan_cache(plan,snapshot,cursor) VALUES($1,$2,$3)", [
      "archived",
      JSON.stringify(snapshot),
      4,
    ]);
    for (const row of drafts)
      await db.query("INSERT INTO plan_editors(plan,editor,draft) VALUES($1,$2,$3)", [
        "archived",
        row.editor,
        JSON.stringify(row.draft),
      ]);
    const statuses = ["pending", "conflict", "rejected"];
    for (const [index, status] of statuses.entries())
      await db.query(
        "INSERT INTO plan_outbox(request_id,plan,editor,command,generation,status,rejection,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          `legacy-${index}`,
          "archived",
          "closed-owner",
          JSON.stringify({
            kind: "html",
            requestId: `legacy-${index}`,
            actor: actor("Alex", "human"),
            html: `<p>Request ${index}\nexact bytes</p>`,
            baseHtmlRevision: 1,
          }),
          8,
          status,
          status === "rejected"
            ? JSON.stringify({ status: 413, message: "Original refusal" })
            : null,
          "2026-10-03T00:00:00.000Z",
        ],
      );
    const oldComment = {
      kind: "comment.add" as const,
      requestId: "before-upgrade-comment",
      actor: actor("Alex", "human"),
      text: "Queued before upgrade",
      anchor: { elementId: "live", quote: "Accepted", x: 0, y: 0 },
    };
    await db.query(
      "INSERT INTO plan_outbox(request_id,plan,editor,command,generation) VALUES($1,$2,$3,$4,0)",
      [oldComment.requestId, "archived", "closed-owner", JSON.stringify(oldComment)],
    );
    const originalRequests = (
      await db.query<{ item: unknown }>(
        "SELECT to_jsonb(o) AS item FROM plan_outbox o WHERE command->>'kind'='html' ORDER BY request_id",
      )
    ).rows.map((row) => row.item);
    await db.close();
    db = await PGlite.create({ dataDir: directory, relaxedDurability: false });
    await LocalDatabase.initialize(db);
    const store = new LocalDatabase(db, "archived", "new-reader");
    const archive = await store.archive();
    expect(archive?.editors.sort((a, b) => a.editor.localeCompare(b.editor))).toEqual(
      drafts.sort((a, b) => a.editor.localeCompare(b.editor)),
    );
    expect(archive?.outbox.sort((a, b) => a.request_id.localeCompare(b.request_id))).toEqual(
      originalRequests,
    );
    expect((await store.read()).commentReady).toBe(false);
    const next = {
      ...snapshot,
      html: "<p id='live'>New agent HTML</p>",
      htmlRevision: 4,
      revision: 5,
    };
    await store.initialize(next);
    expect((await store.read()).commentReady).toBe(true);
    expect((await store.read()).snapshot?.html).toBe(next.html);
    expect((await store.pending()).map((row) => row.command)).toEqual([oldComment]);
    await store.accept(next, "legacy-0");
    expect((await store.pending()).map((row) => row.command)).toEqual([oldComment]);
    await store.accept(next, oldComment.requestId);
    expect(await store.pending()).toEqual([]);
    await expect(
      store.queueCommand({
        kind: "html",
        requestId: "forbidden",
        actor: actor("Alex", "human"),
        html: "bad",
        baseHtmlRevision: 4,
      }),
    ).rejects.toThrow("cannot submit HTML");
    const comment = {
      kind: "comment.add" as const,
      requestId: "comment",
      actor: actor("Casey", "human"),
      text: "Comments work despite archived conflict",
      anchor: { elementId: "live", quote: "Accepted", x: 0, y: 0 },
    };
    await store.queueCommand(comment);
    expect((await store.pending()).map((item) => item.command)).toEqual([comment]);
    await store.accept({ ...next, revision: 6 }, ["legacy-0", "comment"]);
    expect(await store.pending()).toEqual([]);
    expect(await store.archive()).toEqual(archive);
    await db.close();
    db = await PGlite.create({ dataDir: directory, relaxedDurability: false });
    await LocalDatabase.initialize(db);
    const reopened = new LocalDatabase(db, "archived", "new-reader");
    expect(await reopened.archive()).toEqual(archive);
    expect(await reopened.pending()).toEqual([]);
    const frozen = (
      await db.query<{ editor: string; draft: Draft }>(
        "SELECT editor,draft FROM plan_editors ORDER BY editor",
      )
    ).rows;
    expect(frozen).toEqual(drafts);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

test("a committed comment with lost local acknowledgements keeps composer text and retries its original request exactly once", async () => {
  await withFixture("reader-local-ack-loss", async (f) => {
    const context = await f.context();
    await context.addInitScript(() => {
      const NativeWorker = window.SharedWorker;
      const fault = { drop: false, requestIds: [] as string[] };
      (window as unknown as { commentAckFault: typeof fault }).commentAckFault = fault;
      const originalTimer = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        originalTimer(
          handler,
          fault.drop && delay === 15_000 ? 200 : delay,
          ...args,
        )) as typeof window.setTimeout;
      window.SharedWorker = class extends NativeWorker {
        constructor(url: string | URL, options?: string | WorkerOptions) {
          super(url, options);
          const port = this.port;
          const ids = new Set<number>();
          const post = port.postMessage.bind(port);
          port.postMessage = ((message: {
            id: number;
            operation?: string;
            args?: { requestId: string }[];
          }) => {
            if (message.operation === "queueCommand") {
              ids.add(message.id);
              fault.requestIds.push(message.args![0].requestId);
            }
            post(message);
          }) as typeof port.postMessage;
          Object.defineProperty(port, "onmessage", {
            set(handler: (event: MessageEvent) => void) {
              port.addEventListener("message", (event) => {
                if (fault.drop && ids.has(event.data?.id)) return;
                handler(event);
              });
            },
          });
        }
      };
    });
    const page = await f.page(context, "Alex");
    await context.route("**/commands", (route) => route.abort());
    await page.evaluate(() => {
      (window as unknown as { commentAckFault: { drop: boolean } }).commentAckFault.drop = true;
    });
    await page.locator("#comment-mode").click();
    await page.frameLocator("iframe").locator("#heading").click();
    await page.locator("#comment-text").fill("Keep this uncertain comment");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect
      .poll(() => page.locator("#storage-recovery").isVisible(), { timeout: 10_000 })
      .toBe(true);
    expect(await page.locator("#comment-text").inputValue()).toBe("Keep this uncertain comment");
    expect(await page.locator("#comment-composer").isVisible()).toBe(true);
    await page.evaluate(() => {
      (window as unknown as { commentAckFault: { drop: boolean } }).commentAckFault.drop = false;
    });
    await context.route("**/api/plans/reader-local-ack-loss", (route) => route.abort());
    await page.locator("#retry-storage").click();
    await expect
      .poll(() => page.locator("#storage-recovery").isVisible(), { timeout: 20_000 })
      .toBe(false);
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await context.unroute("**/commands");
    await context.unroute("**/api/plans/reader-local-ack-loss");
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 30_000 })
      .toBe(1);
    expect((await f.snapshot()).comments[0].text).toBe("Keep this uncertain comment");
    const requestIds = await page.evaluate(
      () =>
        (window as unknown as { commentAckFault: { requestIds: string[] } }).commentAckFault
          .requestIds,
    );
    expect(requestIds.length).toBeGreaterThan(1);
    expect(new Set(requestIds).size).toBe(1);
  });
}, 120_000);
