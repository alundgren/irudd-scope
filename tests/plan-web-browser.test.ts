import { expect, test } from "vite-plus/test";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
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
        await page.getByRole("textbox", { name: "HTML source", exact: true }).waitFor();
        await expect
          .poll(
            () => page.getByRole("textbox", { name: "HTML source", exact: true }).inputValue(),
            { timeout: 30_000 },
          )
          .toContain("Human0-000");
        await expect
          .poll(() => page.getByRole("button", { name: "Save now", exact: true }).isEnabled(), {
            timeout: 30_000,
          })
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
            editIntents: await page.evaluate(
              () => (window as unknown as { planEditIntents?: EditIntent[] }).planEditIntents ?? [],
            ),
            recoveryFault: await page.evaluate(
              () => (window as unknown as { recoveryFault?: unknown }).recoveryFault ?? null,
            ),
            visibility: await page.evaluate(() => document.visibilityState),
            status: await page
              .locator("#sync-status")
              .textContent()
              .catch(() => "missing"),
            source: await source(page)
              .inputValue()
              .catch(() => "missing"),
            conflict: await page
              .locator("#conflict")
              .isVisible()
              .catch(() => false),
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
            conflict: item.conflict,
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

const source = (page: Page) => page.getByRole("textbox", { name: "HTML source", exact: true });
type EditIntent = {
  target: string;
  inserted: string;
  before?: { html: string; start: number; end: number; selected: string };
  after?: string;
};
async function edit(page: Page, before: string, after: string) {
  await page.bringToFront();
  await source(page).focus();
  const found = await source(page).evaluate(
    (element, { before, after }) => {
      const input = element as HTMLTextAreaElement;
      const start = input.value.indexOf(before);
      if (start < 0) return false;
      input.setSelectionRange(start, start + before.length);
      const intent: EditIntent = { target: before, inserted: after };
      const state = window as unknown as { planEditIntents?: EditIntent[] };
      (state.planEditIntents ??= []).push(intent);
      input.addEventListener(
        "beforeinput",
        (event) => {
          intent.before = {
            html: input.value,
            start: input.selectionStart,
            end: input.selectionEnd,
            selected: input.value.slice(input.selectionStart, input.selectionEnd),
          };
          // Refuse a shifted selection instead of silently editing a different field.
          if (intent.before.selected !== before) event.preventDefault();
        },
        { once: true },
      );
      input.addEventListener(
        "input",
        () => {
          intent.after = input.value;
        },
        { once: true, capture: true },
      );
      return true;
    },
    { before, after },
  );
  expect(found).toBe(true);
  await page.keyboard.insertText(after);
  const intent = await page.evaluate(() =>
    (window as unknown as { planEditIntents: EditIntent[] }).planEditIntents.at(-1)!,
  );
  expect(intent.before?.selected).toBe(before);
  expect(intent.after).toBe(
    intent.before!.html.slice(0, intent.before!.start) +
      after +
      intent.before!.html.slice(intent.before!.end),
  );
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await expect
    .poll(() => page.locator("#sync-status").textContent(), { timeout: 20_000 })
    .toMatch(/^Saved/);
}

async function visible(page: Page, id: string, expected: string) {
  await expect
    .poll(() => page.frameLocator('iframe[title="Plan preview"]').locator(`#${id}`).textContent(), {
      timeout: 20_000,
    })
    .toBe(expected);
}

test(
  "multiple humans and agents converge visibly through duplicate commands and a server restart",
  async () => {
    const f = await fixture("multiplayer", 6, true);
    try {
      const contextA = await f.context();
      const contextB = await f.context();
      const humans = [await f.page(contextA, "Alex"), await f.page(contextB, "Blair")];
      const witnesses = [await f.page(contextA, "Casey"), await f.page(contextB, "Drew")];
      const rounds = Number(process.env.PLAN_WEB_PRESSURE_ROUNDS ?? 10);
      const latencies: number[] = [];
      const pressureStarted = Date.now();
      for (let step = 1; step <= rounds; step++) {
        const roundStarted = Date.now();
        const previous = String(step - 1).padStart(3, "0");
        const next = String(step).padStart(3, "0");
        const base = await f.snapshot();
        const commands = Array.from({ length: 6 }, (_, i) => ({
          kind: "html",
          requestId: randomUUID(),
          actor: actor(`Agent ${i}`),
          baseHtmlRevision: base.htmlRevision,
          html: base.html.replace(`Agent${i}-${previous}`, `Agent${i}-${next}`),
        }));
        const agents = Promise.all(
          commands.flatMap((command) => [f.command(command), f.command(command)]),
        );
        await Promise.all(
          humans.map((page, i) => edit(page, `Human${i}-${previous}`, `Human${i}-${next}`)),
        );
        expect((await agents).every((receipt) => receipt.status === 200)).toBe(true);
        await expect
          .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
          .toContain(`Human1-${next}`);
        for (const page of [...humans, ...witnesses]) {
          const expected = [
            `Human0-${next}`,
            `Human1-${next}`,
            ...Array.from({ length: 6 }, (_, i) => `Agent${i}-${next}`),
          ];
          await expect
            .poll(
              async () => {
                const text = await page
                  .frameLocator('iframe[title="Plan preview"]')
                  .locator("body")
                  .innerText();
                return expected.filter((value) => !text.includes(value));
              },
              { timeout: 20_000 },
            )
            .toEqual([]);
        }
        latencies.push(Date.now() - roundStarted);
        if (step === Math.ceil(rounds / 2)) await f.restart();
      }
      const versions = (await fetch(`${f.api()}/versions?limit=100`).then((response) =>
        response.json(),
      )) as { versions: { revision: number }[] };
      expect(new Set(versions.versions.map((version) => version.revision)).size).toBe(
        versions.versions.length,
      );
      const final = await f.snapshot();
      expect(final.htmlRevision).toBe(2 + rounds * 8);
      for (let index = 0; index < 6; index++)
        expect(final.html).toContain(`Agent${index}-${String(rounds).padStart(3, "0")}`);
      const sorted = [...latencies].sort((a, b) => a - b);
      const evidence = {
        rounds,
        acceptedEdits: rounds * 8,
        duplicateAgentRequests: rounds * 6,
        elapsedMs: Date.now() - pressureStarted,
        medianVisibleMs: sorted[Math.floor(sorted.length / 2)],
        p95VisibleMs: sorted[Math.floor(sorted.length * 0.95)],
        maxVisibleMs: sorted.at(-1),
      };
      if (process.env.PLAN_WEB_PRESSURE_OUTPUT)
        await writeFile(process.env.PLAN_WEB_PRESSURE_OUTPUT, JSON.stringify(evidence, null, 2));
    } catch (error) {
      await f.evidence();
      throw error;
    } finally {
      await f.close();
    }
  },
  Math.max(180_000, Number(process.env.PLAN_WEB_PRESSURE_ROUNDS ?? 10) * 5_000),
);

test("durable distinct tab drafts and orphaned queued edits survive reload and owner tab closure", async () => {
  const f = await fixture("tab-recovery", 1);
  try {
    const context = await f.context();
    const leader = await f.page(context, "First tab");
    const survivor = await f.page(context, "Second tab");
    const apiPattern = "**/api/plans/**";
    await context.route(apiPattern, (route) => route.abort());
    await edit(leader, "Human0-000", "Human0-offline");
    await edit(survivor, "Human1-000", "Human1-offline");
    await expect.poll(() => source(leader).inputValue()).toContain("Human0-offline");
    await expect.poll(() => source(survivor).inputValue()).toContain("Human1-offline");
    await survivor.reload();
    await expect
      .poll(() => source(survivor).inputValue(), { timeout: 30_000 })
      .toContain("Human1-offline");
    expect(await source(survivor).inputValue()).not.toContain("Human0-offline");
    await leader.close();
    await context.unroute(apiPattern);
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 30_000 })
      .toContain("Human0-offline");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 30_000 })
      .toContain("Human1-offline");
    await visible(survivor, "human-0", "Human0-offline");
    await visible(survivor, "human-1", "Human1-offline");
    await survivor.reload();
    await visible(survivor, "human-0", "Human0-offline");
    await visible(survivor, "human-1", "Human1-offline");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("an accepted edit with a lost response preserves later typing and a competing agent edit", async () => {
  const f = await fixture("lost-response", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Morgan");
    f.blockEvents();
    await expect.poll(f.blockedEvents, { timeout: 20_000 }).toBeGreaterThan(0);
    let accepted = false;
    await page.route("**/commands", async (route) => {
      if (!accepted) {
        await route.fetch();
        accepted = true;
      }
      await route.abort();
    });
    await edit(page, "Human0-000", "Human0-first");
    await expect.poll(() => accepted, { timeout: 20_000 }).toBe(true);
    await edit(page, "Human0-first", "Human0-newer");
    const base = await f.snapshot();
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Remote agent"),
          baseHtmlRevision: base.htmlRevision,
          html: base.html.replace("Agent0-000", "Agent0-remote"),
        })
      ).status,
    ).toBe(200);
    await page.reload();
    await expect
      .poll(() => source(page).inputValue(), { timeout: 30_000 })
      .toContain("Human0-newer");
    await page.unroute("**/commands");
    f.unblockEvents();
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 30_000 })
      .toContain("Human0-newer");
    await visible(page, "human-0", "Human0-newer");
    await visible(page, "agent-0", "Agent0-remote");
    expect((await f.snapshot()).htmlRevision).toBe(5);
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("overlapping human edits keep a recoverable conflict across reload", async () => {
  const f = await fixture("overlap", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Rowan");
    f.blockEvents();
    await expect.poll(f.blockedEvents, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.route("**/commands", (route) => route.abort());
    await page.reload();
    await expect.poll(() => source(page).isEditable(), { timeout: 30_000 }).toBe(true);
    await edit(page, "Human0-000", "Human0-local");
    const base = await f.snapshot();
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Agent"),
          baseHtmlRevision: base.htmlRevision,
          html: base.html.replace("Human0-000", "Human0-server"),
        })
      ).status,
    ).toBe(200);
    await page.unroute("**/commands");
    await page
      .getByRole("textbox", { name: "Merge local HTML", exact: true })
      .waitFor({ timeout: 30_000 });
    expect(await source(page).inputValue()).toContain("Human0-local");
    await page.reload();
    const merge = page.getByRole("textbox", { name: "Merge local HTML", exact: true });
    await merge.waitFor({ timeout: 30_000 });
    expect(await source(page).inputValue()).toContain("Human0-local");
    expect((await f.snapshot()).html).toContain("Human0-server");
    await merge.fill((await f.snapshot()).html.replace("Human0-server", "Human0-reconciled"));
    await page.getByRole("button", { name: "Retry merged HTML", exact: true }).click();
    f.unblockEvents();
    await visible(page, "human-0", "Human0-reconciled");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-reconciled");
    await expect.poll(async () => (await f.snapshot()).htmlRevision, { timeout: 20_000 }).toBe(4);
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("human comments remain visible after anchors disappear and reconnect without ambiguity", async () => {
  const f = await fixture("discussion", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Ellis");
    await page.getByRole("button", { name: "Comment on preview", exact: true }).click();
    await page.frameLocator('iframe[title="Plan preview"]').locator("#decision p").click();
    await page
      .getByRole("textbox", { name: "Comment text", exact: true })
      .fill("Keep the rollout reversible.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 20_000 })
      .toBe(1);
    await page.getByText("Keep the rollout reversible.", { exact: true }).waitFor();
    const added = await f.snapshot();
    const anchorId = added.comments[0].anchor.elementId;
    expect(anchorId).toBeTruthy();
    await page
      .getByRole("textbox", { name: "Reply text", exact: true })
      .fill("Agreed. Keep a rollback step.");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByRole("button", { name: /^Version 2 ·/ }).click();
    await expect
      .poll(() => page.getByRole("textbox", { name: "Reply text", exact: true }).count())
      .toBe(0);
    await page.getByRole("button", { name: "Return to live plan", exact: true }).click();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Reply text", exact: true }).inputValue()).toBe(
      "Agreed. Keep a rollback step.",
    );
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments[0].replies.length, { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(() => page.getByRole("textbox", { name: "Reply text", exact: true }).inputValue(), {
        timeout: 20_000,
      })
      .toBe("");
    const current = await f.snapshot();
    const without = current.html.replace(/<section id="decision">[\s\S]*?<\/section>/, "");
    expect(without).not.toBe(current.html);
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Agent"),
          baseHtmlRevision: current.htmlRevision,
          html: without,
        })
      ).status,
    ).toBe(200);
    await page.getByText("Detached", { exact: false }).waitFor({ timeout: 20_000 });
    await page.getByText("Keep the rollout reversible.", { exact: true }).waitFor();
    const removed = await f.snapshot();
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Agent"),
          baseHtmlRevision: removed.htmlRevision,
          html: current.html,
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(() => page.getByText("Detached", { exact: false }).count(), { timeout: 20_000 })
      .toBe(0);
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments[0].resolved, { timeout: 20_000 })
      .toBe(true);
    await page.reload();
    await page
      .getByText("Agreed. Keep a rollback step.", { exact: false })
      .waitFor({ timeout: 30_000 });
    expect((await f.snapshot()).comments[0].anchor.elementId).toBe(anchorId);
    const historical = (await fetch(`${f.api()}/versions/${added.revision}`).then((response) =>
      response.json(),
    )) as PlanSnapshot;
    expect(historical.comments[0].resolved).toBe(false);
    expect(historical.comments[0].replies).toHaveLength(0);
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("a closed editor's successor draft is sent by a surviving tab", async () => {
  const f = await fixture("closed-successor", 1);
  try {
    const context = await f.context();
    const first = await f.page(context, "Leaving editor");
    const survivor = await f.page(context, "Recovery editor");
    await survivor.route("**/commands", (route) => route.abort());
    f.blockEvents();
    await expect.poll(f.blockedEvents, { timeout: 20_000 }).toBeGreaterThan(0);
    let accepted = false;
    await first.route("**/commands", async (route) => {
      if (!accepted) {
        await route.fetch();
        accepted = true;
      }
      await route.abort();
    });
    await edit(first, "Human0-000", "Human0-first");
    await expect.poll(() => accepted, { timeout: 20_000 }).toBe(true);
    await edit(first, "Human0-first", "Human0-last");
    await expect
      .poll(() => first.locator("#sync-status").textContent(), { timeout: 20_000 })
      .toContain("Saved locally");
    expect((await f.snapshot()).html).toContain("Human0-first");
    expect((await f.snapshot()).html).not.toContain("Human0-last");
    await first.close();
    await survivor.unroute("**/commands");
    f.unblockEvents();
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 30_000 })
      .toContain("Human0-last");
    await visible(survivor, "human-0", "Human0-last");
    const versions = (await fetch(`${f.api()}/versions?limit=100`).then((response) =>
      response.json(),
    )) as { versions: { actor: Actor; snapshot: PlanSnapshot }[] };
    expect(
      versions.versions.find((version) => version.snapshot.html.includes("Human0-last"))?.actor
        .name,
    ).toBe("Alex");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("a hanging command response cannot strand newer typing", async () => {
  const f = await fixture("hanging-response", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Patient editor");
    let accepted = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/commands", async (route) => {
      if (!accepted) {
        await route.fetch();
        accepted = true;
        await held;
        await route.abort().catch(() => {});
      } else await route.continue();
    });
    try {
      await edit(page, "Human0-000", "Human0-first");
      await expect.poll(() => accepted, { timeout: 20_000 }).toBe(true);
      await edit(page, "Human0-first", "Human0-next");
      await expect
        .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
        .toContain("Human0-next");
      await visible(page, "human-0", "Human0-next");
    } finally {
      release();
    }
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("a copied tab identity keeps independent durable drafts", async () => {
  const f = await fixture("copied-tab", 1);
  try {
    const context = await f.context();
    const first = await f.page(context, "Original editor");
    const popupPromise = first.waitForEvent("popup");
    await first.evaluate(() => {
      window.open(location.href, "_blank");
    });
    const copied = await popupPromise;
    await expect
      .poll(() => source(copied).inputValue(), { timeout: 30_000 })
      .toContain("Human0-000");
    await expect
      .poll(() => copied.getByRole("button", { name: "Save now", exact: true }).isEnabled(), {
        timeout: 30_000,
      })
      .toBe(true);
    const identities = await Promise.all(
      [first, copied].map((page) =>
        page.evaluate(() => sessionStorage.getItem("scope-plan-editor-id")),
      ),
    );
    expect(identities[0]).not.toBe(identities[1]);
    await context.route("**/api/plans/**", (route) => route.abort());
    await edit(first, "Human0-000", "Human0-original");
    await edit(copied, "Human1-000", "Human1-copied");
    await copied.reload();
    await expect
      .poll(() => source(copied).inputValue(), { timeout: 30_000 })
      .toContain("Human1-copied");
    expect(await source(copied).inputValue()).not.toContain("Human0-original");
    await first.close();
    await context.unroute("**/api/plans/**");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 30_000 })
      .toContain("Human0-original");
    await visible(copied, "human-1", "Human1-copied");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("script-generated lookalikes stay detached while authored elements receive stable anchors", async () => {
  const f = await fixture("runtime-anchor", 1);
  try {
    const current = await f.snapshot();
    const scripted = current.html.replace(
      "</body>",
      `<script>
      const authored = document.querySelector('#decision p');
      const generated = document.createElement('p');
      generated.textContent = authored.textContent;
      generated.dataset.generated = 'true';
      authored.before(generated);
    </script></body>`,
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
    const context = await f.context();
    const page = await f.page(context, "Anchor reviewer");
    await page.getByRole("button", { name: "Comment on preview", exact: true }).click();
    await page
      .frameLocator('iframe[title="Plan preview"]')
      .locator('[data-generated="true"]')
      .click();
    await page
      .getByRole("textbox", { name: "Comment text", exact: true })
      .fill("This was generated at runtime.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 20_000 })
      .toBe(1);
    const generatedComment = await f.snapshot();
    expect(generatedComment.comments[0].anchor.elementId).toBeNull();
    expect(generatedComment.html).toBe(scripted);
    await page.getByRole("button", { name: "Comment on preview", exact: true }).click();
    await page
      .frameLocator('iframe[title="Plan preview"]')
      .locator("#decision p:not([data-generated])")
      .click();
    await page
      .getByRole("textbox", { name: "Comment text", exact: true })
      .fill("This belongs to the authored paragraph.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 20_000 })
      .toBe(2);
    const authoredComment = await f.snapshot();
    expect(authoredComment.comments[1].anchor.elementId).toBeTruthy();
    const id = authoredComment.comments[1].anchor.elementId!;
    await expect
      .poll(() =>
        page.frameLocator('iframe[title="Plan preview"]').locator(`[id="${id}"]`).textContent(),
      )
      .toBe("Keep every accepted edit.");
    await expect
      .poll(() =>
        page
          .frameLocator('iframe[title="Plan preview"]')
          .locator("[data-generated]")
          .getAttribute("id"),
      )
      .toBeNull();
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("hanging presence is coalesced while durable edits remain usable", async () => {
  const f = await fixture("presence-pressure", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Moving editor");
    let attempts = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/presence", async (route) => {
      attempts++;
      await held;
      await route.abort().catch(() => {});
    });
    try {
      for (let index = 0; index < 10; index++) {
        await page
          .frameLocator('iframe[title="Plan preview"]')
          .locator(`#human-${index % 2}`)
          .hover();
      }
      await expect.poll(() => attempts, { timeout: 5_000 }).toBe(1);
      await edit(page, "Human0-000", "Human0-moving");
      await expect
        .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
        .toContain("Human0-moving");
      await visible(page, "human-0", "Human0-moving");
      expect(attempts).toBeLessThanOrEqual(2);
    } finally {
      release();
    }
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("plain HTTP shows the plan and explains why durable editing is unavailable", async () => {
  const f = await fixture("insecure-context", 1);
  try {
    const context = await f.context();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${f.address().replace("127.0.0.1", "scope.local")}/plans/insecure-context`);
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    await expect.poll(() => source(page).inputValue(), { timeout: 20_000 }).toContain("Human0-000");
    expect(await source(page).isEditable()).toBe(false);
    expect(await page.getByRole("button", { name: "Save now", exact: true }).isEnabled()).toBe(
      false,
    );
    expect(
      await page.getByRole("button", { name: "Comment on preview", exact: true }).isEnabled(),
    ).toBe(false);
    expect(await page.locator("#sync-status").textContent()).toContain("HTTPS or localhost");
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 60_000);

test("committed local drafts and commands recover after the database worker is terminated", async () => {
  const f = await fixture("database-worker-crash", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Crash recovery editor");
    const witness = await f.page(context, "Crash witness");
    await context.route("**/api/plans/**", (route) => route.abort());
    await edit(page, "Human0-000", "Human0-durable");
    const session = await f.browser.newBrowserCDPSession();
    try {
      const targets = await session.send("Target.getTargets");
      const worker = targets.targetInfos.find(
        (target: { type: string; url: string }) =>
          target.type === "shared_worker" && target.url.includes("database-worker"),
      );
      if (!worker) throw new Error("Expected the fixture's shared database worker.");
      expect(
        (await session.send("Target.closeTarget", { targetId: worker.targetId })).success,
      ).toBe(true);
    } finally {
      await session.detach();
    }
    await page.reload();
    await expect
      .poll(() => source(page).inputValue(), { timeout: 30_000 })
      .toContain("Human0-durable");
    await context.unroute("**/api/plans/**");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 30_000 })
      .toContain("Human0-durable");
    await visible(page, "human-0", "Human0-durable");
    await witness.reload();
    await visible(witness, "human-0", "Human0-durable");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("eight tabs in one browser share realtime capacity without starving commands", async () => {
  const f = await fixture("eight-tabs", 1, true);
  try {
    const context = await f.context();
    const tabs = await Promise.all(
      Array.from({ length: 8 }, (_, index) => f.page(context, `Tab ${index + 1}`)),
    );
    await edit(tabs[0], "Human0-000", "Human0-eight-tabs");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-eight-tabs");
    for (const tab of tabs) await visible(tab, "human-0", "Human0-eight-tabs");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("one browser can keep eight different plans live without exhausting HTTP connections", async () => {
  const f = await fixture("many-plans", 1, true);
  try {
    const context = await f.context();
    const names = Array.from({ length: 8 }, (_, index) => `many-plans-${index}`);
    for (const name of names) {
      const api = `${f.address()}/api/plans/${name}`;
      const snapshot = (await fetch(api).then((response) => response.json())) as PlanSnapshot;
      expect(
        (
          await fetch(`${api}/commands`, {
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
    const tabs = await Promise.all(
      names.map((name, index) => f.page(context, `Plan editor ${index}`, name)),
    );
    await Promise.all(tabs.map((tab, index) => edit(tab, "Human0-000", `Human0-plan-${index}`)));
    for (const [index, name] of names.entries()) {
      await expect
        .poll(
          async () =>
            (
              (await fetch(`${f.address()}/api/plans/${name}`).then((response) =>
                response.json(),
              )) as PlanSnapshot
            ).html,
          { timeout: 20_000 },
        )
        .toContain(`Human0-plan-${index}`);
      await visible(tabs[index], "human-0", `Human0-plan-${index}`);
    }
    await tabs[0].close();
    await f.restart();
    await edit(tabs[7], "Human0-plan-7", "Human0-plan-7-reconnected");
    await expect
      .poll(
        async () =>
          (
            (await fetch(`${f.address()}/api/plans/${names[7]}`).then((response) =>
              response.json(),
            )) as PlanSnapshot
          ).html,
        { timeout: 20_000 },
      )
      .toContain("Human0-plan-7-reconnected");
    await visible(tabs[7], "human-0", "Human0-plan-7-reconnected");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 180_000);

test("comment anchors preserve unquoted URLs and escaped script source", async () => {
  const f = await fixture("html-parser", 1);
  try {
    const current = await f.snapshot();
    const scripted = current.html.replace(
      "</body>",
      `<a href=/guide/>Read</a><script>
      <!--
      window.example = "<script></script><p>Hello</p>";
      // -->
    </script></body>`,
    );
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("HTML author"),
          baseHtmlRevision: current.htmlRevision,
          html: scripted,
        })
      ).status,
    ).toBe(200);
    const context = await f.context();
    const page = await f.page(context, "Source reviewer");
    const frame = page.frameLocator('iframe[title="Plan preview"]');
    const example = () =>
      frame
        .locator("body")
        .evaluate(
          (element) => (element.ownerDocument.defaultView as Window & { example?: string }).example,
        );
    await expect.poll(example, { timeout: 20_000 }).toBe("<script></script><p>Hello</p>");
    expect(await frame.getByRole("link", { name: "Read", exact: true }).getAttribute("href")).toBe(
      "/guide/",
    );
    await page.getByRole("button", { name: "Comment on preview", exact: true }).click();
    await frame.getByRole("link", { name: "Read", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Comment text", exact: true })
      .fill("Keep this URL intact.");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments.length, { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(async () => (await f.snapshot()).html.includes(' id="plan-'), { timeout: 20_000 })
      .toBe(true);
    const saved = await f.snapshot();
    expect(saved.html.replace(/ id="plan-[^"]+"/, "")).toBe(scripted);
    expect(await frame.getByRole("link", { name: "Read", exact: true }).getAttribute("href")).toBe(
      "/guide/",
    );
    await expect.poll(example, { timeout: 20_000 }).toBe("<script></script><p>Hello</p>");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("a cached plan stays read-only until its new editor recovery row is ready", async () => {
  const f = await fixture("partial-boot", 1);
  try {
    const context = await f.context();
    const first = await f.page(context, "Existing editor");
    expect(
      (
        await f.command({
          kind: "comment.add",
          requestId: randomUUID(),
          actor: actor("Commenter", "human"),
          anchor: { elementId: "heading", quote: "Launch plan", x: 0.5, y: 0.5 },
          text: "Discuss before typing.",
        })
      ).status,
    ).toBe(200);
    await first.getByText("Discuss before typing.", { exact: true }).waitFor();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route("**/api/plans/partial-boot", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const page = await context.newPage();
    try {
      await page.goto(`${f.address()}/plans/partial-boot`);
      await expect
        .poll(() => source(page).inputValue(), { timeout: 20_000 })
        .toContain("Human0-000");
      expect(await source(page).isEditable()).toBe(false);
      expect(await page.getByRole("button", { name: "Save now", exact: true }).isEnabled()).toBe(
        false,
      );
      expect(await page.locator("#sync-status").textContent()).not.toMatch(/^Saved/);
    } finally {
      release();
    }
    await expect.poll(() => source(page).isEditable(), { timeout: 20_000 }).toBe(true);
    await edit(page, "Human0-000", "Human0-ready");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-ready");
  } finally {
    await f.close();
  }
}, 120_000);

test("a suspended tab catches up when it rejoins a plan still watched by another tab", async () => {
  const f = await fixture("visibility-rejoin", 1);
  try {
    const context = await f.context();
    const page = await f.page(context, "Returning editor");
    const witness = await f.page(context, "Active witness");
    const session = await context.newCDPSession(page);
    try {
      await session.send("Page.setWebLifecycleState", { state: "frozen" });
      // Exceed the worker's subscription lease while the other tab keeps this plan live.
      await witness.waitForTimeout(35_000);
      const current = await f.snapshot();
      expect(
        (
          await f.command({
            kind: "html",
            requestId: randomUUID(),
            actor: actor("Agent during suspension"),
            baseHtmlRevision: current.htmlRevision,
            html: current.html.replace("Agent0-000", "Agent0-while-hidden"),
          })
        ).status,
      ).toBe(200);
      await visible(witness, "agent-0", "Agent0-while-hidden");
      await session.send("Page.setWebLifecycleState", { state: "active" });
      await page.bringToFront();
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await visible(page, "agent-0", "Agent0-while-hidden");
      await edit(page, "Human0-000", "Human0-returned");
      await expect
        .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
        .toContain("Human0-returned");
      await visible(witness, "human-0", "Human0-returned");
    } finally {
      await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      await session.detach();
    }
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("a permanently rejected HTML command survives its owner closing without blocking valid editors", async () => {
  const f = await fixture("rejected-html", 1, true);
  try {
    const context = await f.context();
    const owner = await f.page(context, "Oversized editor");
    const survivor = await f.page(context, "Valid editor");
    const commands: { requestId: string; html?: string }[] = [];
    context.on("request", (request) => {
      if (request.url().endsWith("/commands")) commands.push(request.postDataJSON());
    });
    const initial = await source(owner).inputValue();
    const oversized = `${initial}\n<!--${"x".repeat(2 * 1024 * 1024)}-->`;
    await source(owner).fill(oversized);
    await owner.getByRole("button", { name: "Save now", exact: true }).click();
    await expect
      .poll(() => owner.locator("#sync-status").textContent(), { timeout: 30_000 })
      .toMatch(/^Rejected/);
    expect(await source(owner).inputValue()).toBe(oversized);
    const rejectedId = commands.find((command) => command.html === oversized)?.requestId;
    expect(rejectedId).toBeTruthy();
    const rejectedRequests = commands.filter((command) => command.html === oversized).length;
    await edit(survivor, "Human1-000", "Human1-valid-after-rejection");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human1-valid-after-rejection");
    await survivor.waitForTimeout(3500);
    expect(commands.filter((command) => command.html === oversized)).toHaveLength(rejectedRequests);
    expect(
      commands
        .filter((command) => (command.html?.length ?? 0) > 2 * 1024 * 1024)
        .every((command) => command.requestId === rejectedId),
    ).toBe(true);
    await owner.close();
    await edit(survivor, "Human1-valid-after-rejection", "Human1-valid-after-owner-close");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human1-valid-after-owner-close");
    await survivor.reload();
    await expect.poll(() => source(survivor).isEditable(), { timeout: 30_000 }).toBe(true);
    await survivor.getByRole("button", { name: "Rejected changes", exact: true }).click();
    await survivor
      .getByText("Alex · html · HTTP 400: Command body exceeds 2 MiB.", { exact: true })
      .waitFor();
    await survivor.getByRole("button", { name: "Restore rejected HTML", exact: true }).click();
    await expect.poll(() => source(survivor).inputValue(), { timeout: 20_000 }).toBe(oversized);
    const current = await f.snapshot();
    const smaller = current.html.replace("Human0-000", "Human0-smaller-replacement");
    await source(survivor).fill(smaller);
    await survivor.getByRole("button", { name: "Save now", exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).html, { timeout: 20_000 }).toBe(smaller);
    expect(commands.find((command) => command.html === smaller)?.requestId).not.toBe(rejectedId);
    expect(
      commands
        .filter((command) => command.requestId === rejectedId)
        .every((command) => command.html === oversized),
    ).toBe(true);
    await survivor.getByRole("button", { name: "Dismiss rejected change", exact: true }).click();
    await survivor.getByText("No rejected changes.", { exact: true }).waitFor();
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

for (const rejectionStatus of [400, 413, 422]) {
  test(`a rejected comment HTTP ${rejectionStatus} persists across reload and supports edited retry and dismissal`, async () => {
    const f = await fixture(`rejected-comment-${rejectionStatus}`, 1, true);
    try {
      const context = await f.context();
      const page = await f.page(context, "Comment editor");
      const ids: string[] = [];
      let rejecting = true;
      await context.route("**/commands", async (route) => {
        const command = route.request().postDataJSON();
        if (command.kind === "comment.add") {
          ids.push(command.requestId);
          if (rejecting) {
            await route.fulfill({
              status: rejectionStatus,
              contentType: rejectionStatus === 413 ? "text/plain" : "application/json",
              body:
                rejectionStatus === 413
                  ? "Payload too large"
                  : JSON.stringify(rejectionStatus === 422 ? null : 42),
            });
            return;
          }
        }
        await route.continue();
      });
      const add = async (text: string) => {
        await page.getByRole("button", { name: "Comments", exact: true }).click();
        await page.getByRole("button", { name: "Comment on preview", exact: true }).click();
        const pin = page.getByRole("button", {
          name: "Comment 1: Smaller accepted comment",
          exact: true,
        });
        if (text === "Dismiss this rejected comment") {
          expect(await pin.isVisible()).toBe(true);
          expect(await pin.isEnabled()).toBe(false);
          expect(await pin.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
            "none",
          );
        }
        await page.frameLocator('iframe[title="Plan preview"]').locator("#heading").click();
        if (text === "Dismiss this rejected comment") {
          expect(await pin.isEnabled()).toBe(true);
          expect(await pin.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
            "auto",
          );
        }
        await page.getByRole("textbox", { name: "Comment text", exact: true }).fill(text);
        await page.getByRole("button", { name: "Add comment", exact: true }).click();
        await expect
          .poll(() => page.locator("#sync-status").textContent(), { timeout: 20_000 })
          .toMatch(/^Rejected/);
      };
      await add("Rejected comment draft");
      const originalId = ids[0];
      await page.reload();
      await expect.poll(() => source(page).isEditable(), { timeout: 30_000 }).toBe(true);
      await page.getByRole("button", { name: "Rejected changes", exact: true }).click();
      await expect
        .poll(
          () =>
            page.getByRole("textbox", { name: "Rejected comment text", exact: true }).inputValue(),
          { timeout: 20_000 },
        )
        .toBe("Rejected comment draft");
      await page
        .getByRole("textbox", { name: "Rejected comment text", exact: true })
        .fill("Smaller accepted comment");
      rejecting = false;
      await page.getByRole("button", { name: "Retry edited comment", exact: true }).click();
      await expect
        .poll(async () => (await f.snapshot()).comments.map((comment) => comment.text), {
          timeout: 20_000,
        })
        .toEqual(["Smaller accepted comment"]);
      expect(ids.at(-1)).not.toBe(originalId);
      const pin = page.getByRole("button", {
        name: "Comment 1: Smaller accepted comment",
        exact: true,
      });
      await pin.waitFor();
      const pinBounds = (await pin.boundingBox())!;
      const headingBounds = (await page
        .frameLocator('iframe[title="Plan preview"]')
        .locator("#heading")
        .boundingBox())!;
      const x = headingBounds.x + headingBounds.width / 2;
      const y = headingBounds.y + headingBounds.height / 2;
      expect(x).toBeGreaterThanOrEqual(pinBounds.x);
      expect(x).toBeLessThanOrEqual(pinBounds.x + pinBounds.width);
      expect(y).toBeGreaterThanOrEqual(pinBounds.y);
      expect(y).toBeLessThanOrEqual(pinBounds.y + pinBounds.height);
      expect(await page.getByRole("textbox", { name: "Reply text", exact: true }).count()).toBe(0);
      await pin.click();
      expect(
        await page
          .getByRole("textbox", { name: "Reply text", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      rejecting = true;
      await add("Dismiss this rejected comment");
      await page.getByRole("button", { name: "Rejected changes", exact: true }).click();
      await page.getByRole("button", { name: "Dismiss rejected change", exact: true }).click();
      await page.getByText("No rejected changes.", { exact: true }).waitFor();
      expect((await f.snapshot()).comments).toHaveLength(1);
    } catch (error) {
      await f.evidence();
      throw error;
    } finally {
      await f.close();
    }
  }, 120_000);
}

test("three fake users stay independent per tab and switching preserves queued authorship and history", async () => {
  const f = await fixture("fake-users", 1, true);
  try {
    const context = await f.context();
    const alex = await f.page(context, "Alex");
    const blair = await f.page(context, "Blair");
    const user = (page: Page) => page.getByRole("combobox", { name: "User", exact: true });
    expect(await user(alex).locator("option").allTextContents()).toEqual([
      "Alex",
      "Blair",
      "Casey",
    ]);
    expect(await user(alex).inputValue()).toBe("fake-user-alex");
    expect(await user(blair).inputValue()).toBe("fake-user-blair");
    const authored: { requestId: string; actor: Actor; html?: string }[] = [];
    const sessions = new Set<string>();
    context.on("request", (request) => {
      if (request.url().endsWith("/commands")) authored.push(request.postDataJSON());
      if (request.url().endsWith("/presence")) sessions.add(request.postDataJSON().sessionId);
    });
    await expect
      .poll(() => alex.locator("#people").textContent(), { timeout: 20_000 })
      .toContain("Blair");
    await context.route("**/commands", (route) => route.abort());
    await edit(alex, "Human0-000", "Human0-authored-Alex");
    await user(alex).selectOption("fake-user-casey");
    expect(await user(blair).inputValue()).toBe("fake-user-blair");
    await expect
      .poll(() => blair.locator("#people").textContent(), { timeout: 20_000 })
      .toContain("Casey");
    await expect
      .poll(() => blair.locator("#people").textContent(), { timeout: 20_000 })
      .toContain("Blair");
    await expect.poll(() => sessions.size, { timeout: 20_000 }).toBe(2);
    await alex.reload();
    await expect.poll(() => source(alex).isEditable(), { timeout: 30_000 }).toBe(true);
    expect(await user(alex).inputValue()).toBe("fake-user-casey");
    expect(await user(blair).inputValue()).toBe("fake-user-blair");
    await context.unroute("**/commands");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-authored-Alex");
    await edit(alex, "Human0-authored-Alex", "Human0-authored-Casey");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-authored-Casey");
    await edit(blair, "Human1-000", "Human1-authored-Blair");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human1-authored-Blair");
    const history = (await fetch(`${f.api()}/versions?limit=100`).then((response) =>
      response.json(),
    )) as { versions: { requestId: string; actor: Actor }[] };
    for (const [text, name, id] of [
      ["Human0-authored-Alex", "Alex", "fake-user-alex"],
      ["Human0-authored-Casey", "Casey", "fake-user-casey"],
      ["Human1-authored-Blair", "Blair", "fake-user-blair"],
    ]) {
      const command = authored.find((command) => command.html?.includes(text));
      expect(command?.actor).toEqual({ id, name, kind: "human" });
      expect(
        history.versions.find((version) => version.requestId === command?.requestId)?.actor,
      ).toEqual({ id, name, kind: "human" });
    }
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("restoring rejected HTML prevents editing until its delayed durable operation finishes", async () => {
  const f = await fixture("restore-busy", 1, true);
  try {
    const context = await f.context();
    const page = await f.page(context, "Alex");
    await context.route("**/commands", async (route) => {
      if (route.request().postDataJSON().html?.includes("Human0-rejected-restore")) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Rejected for recovery test" }),
        });
      } else await route.continue();
    });
    const rejected = (await source(page).inputValue()).replace(
      "Human0-000",
      "Human0-rejected-restore",
    );
    await source(page).fill(rejected);
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect
      .poll(() => page.locator("#sync-status").textContent(), { timeout: 20_000 })
      .toMatch(/^Rejected/);
    await page.getByRole("button", { name: "Rejected changes", exact: true }).click();
    await page.getByRole("button", { name: "Restore rejected HTML", exact: true }).waitFor();
    await page.evaluate(() => {
      const original = MessagePort.prototype.postMessage;
      let release: (() => void) | undefined;
      MessagePort.prototype.postMessage = function (
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        if ((message as { operation?: string })?.operation === "restoreRejected") {
          release = () => original.call(this, message, options as StructuredSerializeOptions);
          (window as unknown as { restoreRequestHeld: boolean }).restoreRequestHeld = true;
          return;
        }
        original.call(this, message, options as StructuredSerializeOptions);
      };
      (window as unknown as { releaseRestore: () => void }).releaseRestore = () => {
        MessagePort.prototype.postMessage = original;
        release?.();
      };
    });
    await page.getByRole("button", { name: "Restore rejected HTML", exact: true }).click();
    await expect.poll(() => source(page).isEditable(), { timeout: 5000 }).toBe(false);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { restoreRequestHeld: boolean }).restoreRequestHeld,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    expect(
      await page
        .locator("#merge-html")
        .evaluate((element) => (element as HTMLTextAreaElement).readOnly),
    ).toBe(true);
    expect(await page.locator("#sync-status").textContent()).toBe("Restoring HTML…");
    expect(await page.locator("#retry-merged").isEnabled()).toBe(false);
    expect(await page.locator("#use-server").isEnabled()).toBe(false);
    await page.getByRole("button", { name: "Saved browser drafts", exact: true }).click();
    await page.getByRole("button", { name: "Restore draft", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Restore draft", exact: true }).isEnabled()).toBe(
      false,
    );
    await expect(
      source(page).fill("Typing during restore must be refused", { timeout: 500 }),
    ).rejects.toThrow(/not editable|readonly|read-only/i);
    expect(await source(page).inputValue()).toBe(rejected);
    await page.evaluate(() =>
      (window as unknown as { releaseRestore: () => void }).releaseRestore(),
    );
    await expect.poll(() => source(page).isEditable(), { timeout: 20_000 }).toBe(true);
    expect(await source(page).inputValue()).toBe(rejected);
    await edit(page, "Human0-rejected-restore", "Human0-after-restoration");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-after-restoration");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("saved browser draft recovery locks editing and survives committed but lost replies exactly once", async () => {
  const f = await fixture("saved-draft-recovery", 1, true);
  try {
    const context = await f.context();
    const page = await f.page(context, "Alex");
    await context.route("**/commands", async (route) => {
      if (route.request().postDataJSON().html?.includes("Human0-saved-recovery"))
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Park this draft for recovery" }),
        });
      else await route.continue();
    });
    const rejected = (await source(page).inputValue()).replace(
      "Human0-000",
      "Human0-saved-recovery",
    );
    await source(page).fill(rejected);
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect
      .poll(() => page.locator("#sync-status").textContent(), { timeout: 20_000 })
      .toMatch(/^Rejected/);
    await page.evaluate(() => {
      const original = MessagePort.prototype.postMessage;
      const replies = new Set<number>();
      const observed = new WeakSet<MessagePort>();
      const fault = {
        held: false,
        lost: 0,
        initialGeneration: -1,
        operationIds: [] as string[],
        generations: [] as number[],
      };
      let release: (() => void) | undefined;
      MessagePort.prototype.postMessage = function (
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as { id: number; operation?: string; args?: unknown[] };
        if (!observed.has(this)) {
          observed.add(this);
          const handler = this.onmessage;
          this.onmessage = (event: MessageEvent) => {
            if (replies.has(event.data?.id) && fault.lost < 3) {
              fault.lost++;
              return;
            }
            if (event.data?.result?.[0]?.draft && fault.initialGeneration < 0)
              fault.initialGeneration = event.data.result[0].draft.generation;
            if (event.data?.result?.draft)
              fault.generations.push(event.data.result.draft.generation);
            handler?.call(this, event);
          };
        }
        if (request.operation === "recover") {
          replies.add(request.id);
          fault.operationIds.push(request.args?.[2] as string);
          if (!fault.held) {
            fault.held = true;
            release = () => original.call(this, message, options as StructuredSerializeOptions);
            return;
          }
        }
        original.call(this, message, options as StructuredSerializeOptions);
      };
      Object.assign(window, { recoveryFault: fault, releaseRecovery: () => release?.() });
    });
    await page.getByRole("button", { name: "Saved browser drafts", exact: true }).click();
    await page.getByRole("button", { name: "Restore draft", exact: true }).waitFor();
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { recoveryFault: { held: boolean } }).recoveryFault.held,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    expect(await source(page).isEditable()).toBe(false);
    expect(
      await page
        .locator("#merge-html")
        .evaluate((element) => (element as HTMLTextAreaElement).readOnly),
    ).toBe(true);
    expect(await page.locator("#retry-merged").isEnabled()).toBe(false);
    expect(await page.locator("#use-server").isEnabled()).toBe(false);
    await expect(
      source(page).fill("Typing during recovery must be refused", { timeout: 500 }),
    ).rejects.toThrow(/not editable|readonly|read-only/i);
    await page.evaluate(() =>
      (window as unknown as { releaseRecovery: () => void }).releaseRecovery(),
    );
    await page
      .getByRole("button", { name: "Retry local save", exact: true })
      .waitFor({ timeout: 60_000 });
    expect(await source(page).isEditable()).toBe(false);
    await page.getByRole("button", { name: "Saved browser drafts", exact: true }).click();
    await page.getByRole("button", { name: "Restore draft", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Restore draft", exact: true }).isEnabled()).toBe(
      false,
    );
    await page.getByRole("button", { name: "Retry local save", exact: true }).click();
    await expect.poll(() => source(page).isEditable(), { timeout: 20_000 }).toBe(true);
    expect(await source(page).inputValue()).toBe(rejected);
    const fault = await page.evaluate(
      () =>
        (
          window as unknown as {
            recoveryFault: {
              lost: number;
              initialGeneration: number;
              operationIds: string[];
              generations: number[];
            };
          }
        ).recoveryFault,
    );
    expect(fault.lost).toBe(3);
    expect(fault.operationIds).toHaveLength(4);
    expect(new Set(fault.operationIds).size).toBe(1);
    expect(fault.initialGeneration).toBeGreaterThanOrEqual(1);
    expect(fault.generations).toContain(fault.initialGeneration + 1);
    expect(Math.max(...fault.generations)).toBe(fault.initialGeneration + 1);
    await edit(page, "Human0-saved-recovery", "Human0-after-saved-recovery");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-after-saved-recovery");
    await page.reload();
    await expect
      .poll(() => source(page).inputValue(), { timeout: 30_000 })
      .toContain("Human0-after-saved-recovery");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("a cached snapshot with remote changes around an uncommitted local edit reconciles without false conflict", async () => {
  const f = await fixture("multi-range-reconcile", 1, true);
  try {
    const context = await f.context();
    const page = await f.page(context, "Blair");
    const witness = await f.page(context, "Casey");
    await page.evaluate(() => {
      const original = MessagePort.prototype.postMessage;
      const held: (() => void)[] = [];
      MessagePort.prototype.postMessage = function (
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        if ((message as { operation?: string })?.operation === "saveDraft") {
          held.push(() => original.call(this, message, options as StructuredSerializeOptions));
          (window as unknown as { draftRequestHeld: boolean }).draftRequestHeld = true;
          return;
        }
        original.call(this, message, options as StructuredSerializeOptions);
      };
      (window as unknown as { releaseDraft: () => void }).releaseDraft = () => {
        MessagePort.prototype.postMessage = original;
        for (const release of held) release();
      };
    });
    await source(page).fill(
      (await source(page).inputValue()).replace("Human1-000", "Human1-local"),
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { draftRequestHeld: boolean }).draftRequestHeld,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    const current = await f.snapshot();
    expect(
      (
        await f.command({
          kind: "html",
          requestId: randomUUID(),
          actor: actor("Remote agent"),
          baseHtmlRevision: current.htmlRevision,
          html: current.html
            .replace("Human0-000", "Human0-remote")
            .replace("Agent0-000", "Agent0-remote"),
        })
      ).status,
    ).toBe(200);
    await visible(witness, "human-0", "Human0-remote");
    await visible(witness, "agent-0", "Agent0-remote");
    await page.evaluate(() => (window as unknown as { releaseDraft: () => void }).releaseDraft());
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human1-local");
    const final = await f.snapshot();
    expect(final.html).toContain("Human0-remote");
    expect(final.html).toContain("Agent0-remote");
    expect(await page.locator("#conflict").isVisible()).toBe(false);
    await visible(page, "human-1", "Human1-local");
    await visible(page, "human-0", "Human0-remote");
    await visible(page, "agent-0", "Agent0-remote");
    await page.reload();
    await visible(page, "human-1", "Human1-local");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);

test("explicit old-source paste versions its rollback while native field edits preserve newer remote content", async () => {
  const f = await fixture("source-input-intent", 1, true);
  try {
    const context = await f.context();
    const page = await f.page(context, "Alex");
    const oldSource = await source(page).inputValue();
    const remote = async (text: string) => {
      const current = await f.snapshot();
      expect(
        (
          await f.command({
            kind: "html",
            requestId: randomUUID(),
            actor: actor("Remote agent"),
            baseHtmlRevision: current.htmlRevision,
            html: current.html.replace(/Agent0-[^<]+/, text),
          })
        ).status,
      ).toBe(200);
      await visible(page, "agent-0", text);
    };
    await remote("Agent0-remote");
    const pasted = oldSource.replace("Human0-000", "Human0-pasted");
    await source(page).fill(pasted);
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect.poll(async () => (await f.snapshot()).html, { timeout: 20_000 }).toBe(pasted);
    const pasteSnapshot = await f.snapshot();
    const versions = (await fetch(`${f.api()}/versions?limit=100`).then((response) =>
      response.json(),
    )) as { versions: { revision: number; diff: string; snapshot: PlanSnapshot }[] };
    const pasteVersion = versions.versions.find(
      (version) => version.revision === pasteSnapshot.revision,
    )!;
    expect(pasteVersion.snapshot.html).toBe(pasted);
    expect(pasteVersion.diff).toContain('-<p id="agent-0">Agent0-remote</p>');
    expect(pasteVersion.diff).toContain('+<p id="agent-0">Agent0-000</p>');
    await remote("Agent0-latest");
    await edit(page, "Human0-pasted", "Human0-native");
    await expect
      .poll(async () => (await f.snapshot()).html, { timeout: 20_000 })
      .toContain("Human0-native");
    expect((await f.snapshot()).html).toContain("Agent0-latest");
    await visible(page, "human-0", "Human0-native");
    await visible(page, "agent-0", "Agent0-latest");
  } catch (error) {
    await f.evidence();
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);
