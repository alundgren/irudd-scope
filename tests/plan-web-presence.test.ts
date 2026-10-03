import { expect, test } from "vite-plus/test";
import {
  chromium,
  expect as browserExpect,
  type BrowserContext,
  type Page,
  type Request as BrowserRequest,
} from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPlanWebServer } from "../apps/plan-web/src/backend/server.ts";
import type { PlanSnapshot, Presence } from "../apps/plan-web/src/contracts.ts";

type Point = { at: number; x: number; y: number };
type StreamPoint = Point & { receipt: number; sessionId: string };
type PostedPoint = Point & Pick<Presence, "sessionId" | "sequence" | "actor">;
type BrowserTrace = { captured: Point[]; visible: Point[]; replacements: number };
const documentHtml = (write = 0) =>
  `<!doctype html><style>body{margin:0}#track{height:240px;width:100%;background:#eee}#below{height:1600px}</style><div id="track">Follow the remote cursor</div><div id="below">Agent write ${write}</div>`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-presence-"));
  const server = await startPlanWebServer({
    databasePath: join(directory, "plans.db"),
    assetsDirectory: resolve("apps/plan-web/dist/client"),
  });
  let jitter = false;
  let packet = 0;
  let activePresence = 0;
  let peakPresence = 0;
  let eventConnections = 0;
  const stream: StreamPoint[] = [];
  const posted: PostedPoint[] = [];
  const opened: Page[] = [];
  const gateway = createServer((incoming, outgoing) => {
    const presence = incoming.url?.endsWith("/presence");
    if (incoming.url?.startsWith("/api/events?")) eventConnections++;
    if (presence) {
      activePresence++;
      peakPresence = Math.max(peakPresence, activePresence);
      outgoing.on("close", () => {
        activePresence--;
      });
    }
    const delay = presence && jitter ? 50 + (packet++ % 3) * 25 : 0;
    const chunks: Buffer[] = [];
    const forward = () => {
      const request = httpRequest(
        new URL(incoming.url ?? "/", server.url),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          if (incoming.url?.startsWith("/api/events?")) {
            let pending = "";
            response.on("data", (chunk: Buffer) => {
              pending += chunk.toString();
              const frames = pending.split("\n\n");
              pending = frames.pop()!;
              for (const frame of frames) {
                if (!frame.includes("event: presence\n")) continue;
                const data = JSON.parse(frame.split("data: ")[1]) as { people: Presence[] };
                for (const person of data.people)
                  stream.push({ at: Date.now(), receipt: person.updatedAt, ...person });
              }
            });
          }
          response.on("error", () => outgoing.destroy());
          if (presence && jitter) {
            response.on("data", (chunk: Buffer) => {
              setTimeout(() => outgoing.write(chunk), 80);
            });
            response.on("end", () => setTimeout(() => outgoing.end(), 80));
          } else response.pipe(outgoing);
        },
      );
      request.on("error", () => outgoing.destroy());
      outgoing.on("close", () => request.destroy());
      if (presence) request.end(Buffer.concat(chunks));
      else incoming.pipe(request);
    };
    if (presence) {
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const input = JSON.parse(Buffer.concat(chunks).toString()) as PostedPoint;
        posted.push({ ...input, at: Date.now() });
        setTimeout(forward, delay);
      });
    } else forward();
  });
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway address");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const api = `${server.url}/api/plans/cursors`;
  const snapshot = async (): Promise<PlanSnapshot> => (await fetch(api)).json();
  const write = async (html: string) => {
    const current = await snapshot();
    const response = await fetch(`${api}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "html",
        requestId: randomUUID(),
        actor: { id: "agent", name: "Agent", kind: "agent" },
        baseHtmlRevision: current.htmlRevision,
        html,
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  await write(documentHtml());
  return {
    posted,
    stream,
    api,
    write,
    snapshot,
    pressure: () => ({ peakPresence, activePresence, eventConnections }),
    context: () => browser.newContext({ viewport: { width: 1440, height: 900 } }),
    setJitter(value: boolean) {
      jitter = value;
    },
    async page(user: "Alex" | "Blair", width = 1440, shared?: BrowserContext) {
      const context = shared ?? (await browser.newContext({ viewport: { width, height: 900 } }));
      if (!shared)
        await context.addInitScript(() => {
          const host = window as unknown as { cursorDelivered: StreamPoint[] };
          host.cursorDelivered = [];
          const Worker = window.SharedWorker;
          window.SharedWorker = class extends Worker {
            constructor(script: string | URL, options?: string | WorkerOptions) {
              super(script, options);
              this.port.addEventListener("message", (event) => {
                if (event.data?.kind !== "stream" || event.data.event !== "presence") return;
                for (const person of event.data.data as Presence[])
                  host.cursorDelivered.push({
                    at: Date.now(),
                    receipt: person.updatedAt,
                    ...person,
                  });
              });
            }
          };
        });
      const page = await context.newPage();
      opened.push(page);
      await page.goto(`${url}/plans/cursors`);
      await expect
        .poll(
          () => page.getByRole("button", { name: "Comment on preview", exact: true }).isEnabled(),
          {
            timeout: 30_000,
          },
        )
        .toBe(true);
      await page.getByRole("combobox", { name: "User" }).selectOption({ label: user });
      await page.frameLocator("iframe").locator("#track").waitFor();
      return page;
    },
    async evidence(path: string) {
      const pages = await Promise.all(
        opened.map((page) =>
          page.evaluate(() => {
            const iframe = document.querySelector("iframe")!;
            return {
              session: sessionStorage.getItem("scope-plan-editor-id"),
              scroll: { x: iframe.contentWindow!.scrollX, y: iframe.contentWindow!.scrollY },
              track: iframe.contentDocument
                ?.getElementById("track")
                ?.getBoundingClientRect()
                .toJSON(),
              cursors: [...document.querySelectorAll<HTMLElement>(".cursor")].map((marker) => ({
                id: marker.dataset.sessionId,
                text: marker.textContent,
                left: marker.style.left,
                top: marker.style.top,
                hidden: marker.hidden,
              })),
            };
          }),
        ),
      );
      await writeFile(path, JSON.stringify({ pages, posted, stream }, null, 2));
    },
    async close() {
      await browser.close();
      gateway.closeAllConnections();
      await new Promise<void>((done) => gateway.close(() => done()));
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function observe(page: Page, captured: boolean) {
  await page.evaluate((capture) => {
    const host = window as unknown as { cursorTrace: BrowserTrace };
    host.cursorTrace = { captured: [], visible: [], replacements: 0 };
    const iframe = document.querySelector("iframe")!;
    const attach = () => {
      if (!capture) return;
      iframe.contentDocument!.addEventListener("pointermove", (event) => {
        const rect = iframe.contentDocument!.getElementById("track")!.getBoundingClientRect();
        host.cursorTrace.captured.push({
          at: Date.now(),
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        });
      });
    };
    iframe.addEventListener("load", attach);
    attach();
    const markers = document.querySelector("#cursor-markers")!;
    const observer = new MutationObserver((mutations) => {
      host.cursorTrace.replacements += mutations.filter(
        (item) => item.type === "childList" && item.removedNodes.length,
      ).length;
    });
    observer.observe(markers, { childList: true });
    let previous = "";
    const sample = () => {
      const marker = [...markers.querySelectorAll<HTMLElement>(".cursor")].find((item) =>
        item.textContent?.includes("Alex"),
      );
      const rect = iframe.contentDocument?.getElementById("track")?.getBoundingClientRect();
      if (marker && rect && !marker.hidden) {
        const point = marker.getBoundingClientRect();
        const bounds = markers.getBoundingClientRect();
        const x = (point.left - bounds.left - rect.left) / rect.width;
        const y = (point.top - bounds.top - rect.top) / rect.height;
        const key = `${x}:${y}`;
        if (key !== previous) host.cursorTrace.visible.push({ at: Date.now(), x, y });
        previous = key;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, captured);
}
const trace = (page: Page): Promise<BrowserTrace> =>
  page.evaluate(() => (window as unknown as { cursorTrace: BrowserTrace }).cursorTrace);
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: values.length,
    median: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
const delivered = (page: Page): Promise<StreamPoint[]> =>
  page.evaluate(() => (window as unknown as { cursorDelivered: StreamPoint[] }).cursorDelivered);
function measurement(
  input: Point[],
  posts: Point[],
  stream: StreamPoint[],
  visible: Point[],
  delivery: StreamPoint[],
) {
  const match = (point: Point, candidates: Point[]) =>
    candidates.findLast(
      (candidate) =>
        Math.abs(candidate.x - point.x) < 0.004 &&
        Math.abs(candidate.y - point.y) < 0.004 &&
        candidate.at <= point.at,
    );
  const last = input.at(-1)!;
  const final = visible.find((point) => point.at >= last.at && Math.abs(point.x - last.x) < 0.004);
  const firstSse = new Map<string, StreamPoint>();
  const firstDelivery = new Map<string, StreamPoint>();
  const firstPost = new Map<string, Point>();
  for (const point of posts) {
    const key = `${point.x}:${point.y}`;
    if (!firstPost.has(key)) firstPost.set(key, point);
  }
  for (const point of stream) {
    const key = `${point.sessionId}:${point.receipt}`;
    if (!firstSse.has(key)) firstSse.set(key, point);
  }
  for (const point of delivery) {
    const key = `${point.sessionId}:${point.receipt}`;
    if (!firstDelivery.has(key)) firstDelivery.set(key, point);
  }
  return {
    inputs: input.length,
    posts: posts.length,
    visibleUpdates: visible.length,
    captureToPost: distribution(
      [...firstPost.values()].flatMap((point) => {
        const captured = match(point, input);
        return captured ? [point.at - captured.at] : [];
      }),
    ),
    captureToVisible: distribution(
      visible.flatMap((point) => {
        const captured = match(point, input);
        return captured ? [point.at - captured.at] : [];
      }),
    ),
    receiptToSse: distribution(
      [...firstSse.values()]
        .filter((point) => match(point, input))
        .map((point) => point.at - point.receipt),
    ),
    sseToBrowser: distribution(
      [...firstDelivery.values()].flatMap((point) => {
        const sse = firstSse.get(`${point.sessionId}:${point.receipt}`);
        return sse && match(point, input) ? [point.at - sse.at] : [];
      }),
    ),
    browserToVisible: distribution(
      visible.flatMap((point) => {
        const received = match(point, delivery);
        return received ? [point.at - received.at] : [];
      }),
    ),
    visibleCadence: distribution(
      visible.slice(1).map((point, index) => point.at - visible[index].at),
    ),
    jumps: distribution(
      visible.slice(1).map((point, index) => Math.abs(point.x - visible[index].x)),
    ),
    stopLag: final ? final.at - last.at : null,
    finalError: Math.abs((visible.at(-1)?.x ?? -1) - last.x),
  };
}

test("another browser receives current cursor positions during movement, jitter and agent writes", async () => {
  const f = await fixture();
  try {
    const sender = await f.page("Alex");
    const receiver = await f.page("Blair", 1280);
    await observe(sender, true);
    await observe(receiver, false);
    const reports = [];
    const clocks = [];
    for (const [name, page] of [
      ["sender", sender],
      ["receiver", receiver],
    ] as const) {
      const before = Date.now();
      const browser = await page.evaluate(() => Date.now());
      const after = Date.now();
      clocks.push({
        name,
        offsetMs: browser - (before + after) / 2,
        uncertaintyMs: (after - before) / 2,
      });
    }
    for (const scenario of ["normal", "jitter", "agent-writes"] as const) {
      f.setJitter(scenario !== "normal");
      const start = Date.now();
      const writes =
        scenario === "agent-writes"
          ? (async () => {
              for (let i = 1; i <= 6; i++) {
                await new Promise((done) => setTimeout(done, 160));
                await f.write(documentHtml(i));
              }
            })()
          : Promise.resolve();
      for (let i = 0; i <= 80; i++) {
        const bounds = await sender.frameLocator("iframe").locator("#track").boundingBox();
        if (!bounds) {
          await sender.frameLocator("iframe").locator("#track").waitFor({ state: "visible" });
          i--;
          continue;
        }
        await sender.mouse.move(bounds.x + bounds.width * (0.1 + (0.75 * i) / 80), bounds.y + 80);
        await new Promise((done) => setTimeout(done, 12));
      }
      await writes;
      await new Promise((done) => setTimeout(done, 650));
      const captured = (await trace(sender)).captured.filter((point) => point.at >= start);
      const visible = (await trace(receiver)).visible.filter((point) => point.at >= start);
      const report = {
        scenario,
        ...measurement(
          captured,
          f.posted.filter((point) => point.at >= start),
          f.stream.filter((point) => point.at >= start),
          visible,
          (await delivered(receiver)).filter((point) => point.at >= start),
        ),
      };
      reports.push(report);
      expect(captured.length).toBeGreaterThan(65);
      expect(visible.length).toBeGreaterThan(4);
      if (!process.env.PLAN_PRESENCE_BASELINE) {
        const current = visible.filter((point) =>
          captured.some((input) => input.at <= point.at && Math.abs(point.x - input.x) < 0.004),
        );
        for (let i = 1; i < current.length; i++)
          expect(current[i].x).toBeGreaterThanOrEqual(current[i - 1].x - 0.0001);
        expect(report.finalError).toBeLessThan(0.004);
        expect(report.stopLag).not.toBeNull();
        expect(report.stopLag!).toBeLessThan(scenario === "normal" ? 200 : 500);
      }
    }
    await writeFile(
      process.env.PLAN_PRESENCE_REPORT ?? "/tmp/plan-web-presence-improved.json",
      JSON.stringify(
        {
          reports,
          clocks,
          sender: await trace(sender),
          receiver: await trace(receiver),
          posted: f.posted,
          stream: f.stream,
          delivered: await delivered(receiver),
        },
        null,
        2,
      ),
    );
  } finally {
    await f.close();
  }
}, 120_000);

test("late and unsequenced presence packets cannot replace a newer sequenced position", async () => {
  const server = await startPlanWebServer({ databasePath: ":memory:" });
  try {
    const api = `${server.url}/api/plans/ordered`;
    const original = (await (await fetch(api)).json()) as PlanSnapshot;
    const post = async (sequence: unknown, x: number, sessionId = "ordered", name = "Alex") => {
      const response = await fetch(`${api}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          actor: { id: name, name, kind: "human" },
          elementId: "title",
          x,
          y: 0.5,
          ...(sequence === undefined ? {} : { sequence }),
        }),
      });
      return { status: response.status, people: (await response.json()) as Presence[] };
    };
    await post(1, 0.1);
    const delayed = new Promise<void>((done) => setTimeout(done, 30)).then(() => post(2, 0.2));
    await post(3, 0.3);
    const afterLate = await delayed;
    expect(afterLate.people.find((person) => person.sessionId === "ordered")?.x).toBe(0.3);
    expect((await post(undefined, 0.1)).people[0].x).toBe(0.3);
    expect((await post(3, 0.2)).people[0].x).toBe(0.3);
    expect((await post(4, 0.4, "ordered", "Casey")).people[0].actor.name).toBe("Casey");
    expect((await post(undefined, 0.1, "legacy")).status).toBe(200);
    expect(
      (await post(undefined, 0.2, "legacy")).people.find((person) => person.sessionId === "legacy")
        ?.x,
    ).toBe(0.2);
    for (const invalid of [-1, 1.5, null, "5", Number.MAX_SAFE_INTEGER + 1])
      expect((await post(invalid, 0.9)).status).toBe(400);
    const current = (await (await fetch(api)).json()) as PlanSnapshot;
    expect(current).toEqual(original);
    const versions = (await (await fetch(`${api}/versions`)).json()) as { versions: unknown[] };
    expect(versions.versions).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("cursors keep their elements, survive reload and follow viewport, scroll and history", async () => {
  const f = await fixture();
  try {
    const comment = await fetch(`${f.api}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "comment.add",
        requestId: randomUUID(),
        actor: { id: "reviewer", name: "Reviewer", kind: "human" },
        text: "Discuss here",
        anchor: { elementId: "track", quote: "Follow the remote cursor", x: 0.2, y: 0.4 },
      }),
    });
    expect(comment.status).toBe(200);
    const sender = await f.page("Alex");
    const receiver = await f.page("Blair", 1280);
    const move = async (fraction: number) => {
      const bounds = await sender.frameLocator("iframe").locator("#track").boundingBox();
      if (!bounds) throw new Error("Missing target");
      await sender.mouse.move(bounds.x + bounds.width * fraction, bounds.y + 80);
    };
    const remote = receiver.locator(".cursor").filter({ hasText: "Alex" });
    await move(0.3);
    await browserExpect(remote).toBeVisible();
    await receiver.evaluate(() => {
      (window as unknown as { presenceNodes: Element[] }).presenceNodes = [
        document.querySelector(".cursor")!,
        document.querySelector(".comment-marker")!,
      ];
    });
    await move(0.4);
    await move(0.65);
    await expect
      .poll(async () => {
        const box = await remote.boundingBox();
        const target = await receiver.frameLocator("iframe").locator("#track").boundingBox();
        return box && target ? Math.abs((box.x - target.x) / target.width - 0.65) : 1;
      })
      .toBeLessThan(0.004);
    expect(
      await receiver.evaluate(() =>
        (window as unknown as { presenceNodes: Element[] }).presenceNodes.every(
          (node) => node.isConnected,
        ),
      ),
    ).toBe(true);
    await receiver.locator(".comment-marker").click();
    await browserExpect(receiver.locator("#discussion")).toContainText("Discuss here");
    await receiver.getByRole("button", { name: "Comment on preview", exact: true }).click();
    const target = await receiver.frameLocator("iframe").locator("#track").boundingBox();
    if (!target) throw new Error("Missing target");
    await receiver.mouse.click(target.x + target.width * 0.2, target.y + 240 * 0.4);
    await browserExpect(
      receiver.getByRole("textbox", { name: "Comment text", exact: true }),
    ).toBeVisible();
    await receiver.getByRole("button", { name: "Cancel", exact: true }).click();
    if (await receiver.locator("#plan-menu").count())
      await receiver.locator("#plan-menu summary").click();
    await receiver.getByRole("button", { name: "History", exact: true }).click();
    await receiver.locator(".version").first().click();
    await browserExpect(remote).toBeHidden();
    await receiver.getByRole("button", { name: "Return to live plan", exact: true }).click();
    await browserExpect(remote).toBeVisible();
    const latest = f.posted.findLast((point) => point.actor.name === "Alex")!;
    await sender.reload();
    await expect
      .poll(
        () => sender.getByRole("button", { name: "Comment on preview", exact: true }).isEnabled(),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    await sender.frameLocator("iframe").locator("#track").waitFor();
    await move(0.8);
    await browserExpect(remote).toBeVisible();
    await expect
      .poll(() => f.posted.findLast((point) => point.actor.name === "Alex")?.sequence ?? 0)
      .toBeGreaterThan(latest.sequence!);
    expect(f.posted.findLast((point) => point.actor.name === "Alex")?.sessionId).toBe(
      latest.sessionId,
    );
    await sender.getByRole("combobox", { name: "User" }).selectOption({ label: "Casey" });
    await browserExpect(receiver.locator(".cursor").filter({ hasText: "Casey" })).toBeVisible();
    await sender.mouse.move(20, 20);
    await browserExpect(receiver.locator(".cursor").filter({ hasText: "Casey" })).toBeHidden();
    for (const page of [sender, receiver]) {
      await page
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() => {
          const below = document.getElementById("below")!;
          below.style.height = "1600px";
          below.removeAttribute("id");
        });
    }
    await sender
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => window.scrollTo(0, 500));
    await receiver
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => window.scrollTo(0, 400));
    const iframe = await sender.locator("iframe").boundingBox();
    if (!iframe) throw new Error("Missing preview");
    await sender.mouse.move(iframe.x + 70, iframe.y + 40);
    await expect
      .poll(async () => {
        const cursor = receiver.locator(".cursor").filter({ hasText: "Casey" });
        return cursor.evaluate((marker) => ({
          x: parseFloat((marker as HTMLElement).style.left),
          y: parseFloat((marker as HTMLElement).style.top),
          hidden: (marker as HTMLElement).hidden,
        }));
      })
      .toEqual({ x: 70, y: 140, hidden: false });
    await sender
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => window.scrollTo(0, 600));
    await expect
      .poll(() =>
        receiver
          .locator(".cursor")
          .filter({ hasText: "Casey" })
          .evaluate((marker) => parseFloat((marker as HTMLElement).style.top)),
      )
      .toBe(240);
    for (const page of [sender, receiver]) {
      await page
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() => window.scrollTo(0, 0));
      await expect
        .poll(() =>
          page
            .frameLocator("iframe")
            .locator("body")
            .evaluate(() => window.scrollY),
        )
        .toBe(0);
    }
    await move(0.6);
    await expect
      .poll(() =>
        receiver
          .locator(".cursor")
          .filter({ hasText: "Casey" })
          .evaluate((marker) => Math.abs(parseFloat((marker as HTMLElement).style.top) - 80)),
      )
      .toBeLessThan(1);
    await browserExpect(receiver.locator(".cursor").filter({ hasText: "Casey" })).toBeVisible();
    await receiver
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => window.scrollTo(0, 600));
    await browserExpect(receiver.locator(".cursor").filter({ hasText: "Casey" })).toBeHidden();
    await receiver
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => window.scrollTo(0, 0));
    await browserExpect(receiver.locator(".cursor").filter({ hasText: "Casey" })).toBeVisible();
    await receiver
      .frameLocator("iframe")
      .locator("#track")
      .evaluate((element) => element.removeAttribute("id"));
    await browserExpect(receiver.locator(".cursor").filter({ hasText: "Casey" })).toBeHidden();
  } catch (error) {
    await f.evidence("/tmp/plan-web-presence-geometry-failure-20261003.json");
    throw error;
  } finally {
    await f.close();
  }
}, 90_000);

test("eight tabs deliver durable comments and final cursors through the shared HTTP connection pool", async () => {
  const f = await fixture();
  try {
    const context = await f.context();
    const pages: Page[] = [];
    for (let i = 0; i < 8; i++) pages.push(await f.page(i === 0 ? "Blair" : "Alex", 1440, context));
    const reader = pages[0];
    await reader.bringToFront();
    const sessions = await Promise.all(
      pages.map((page) => page.evaluate(() => sessionStorage.getItem("scope-plan-editor-id")!)),
    );
    expect(new Set(sessions).size).toBe(8);
    f.setJitter(true);
    const commandTimes = new Map<BrowserRequest, number>();
    const commandLatency: number[] = [];
    for (const page of pages) {
      page.on("request", (request) => {
        if (request.url().endsWith("/commands")) commandTimes.set(request, Date.now());
      });
      page.on("requestfinished", (request) => {
        const start = commandTimes.get(request);
        if (start) commandLatency.push(Date.now() - start);
      });
    }
    const started = Date.now();
    const moving = Promise.all(
      pages.map((page, index) =>
        page.evaluate(async (offset) => {
          for (let step = 0; step <= 40; step++) {
            const iframe = document.querySelector("iframe")!;
            const element = iframe.contentDocument?.getElementById("track");
            if (element) {
              const rect = element.getBoundingClientRect();
              element.dispatchEvent(
                new (
                  iframe.contentWindow as unknown as { PointerEvent: typeof PointerEvent }
                ).PointerEvent("pointermove", {
                  bubbles: true,
                  clientX: rect.left + rect.width * (0.15 + offset * 0.02 + step * 0.01),
                  clientY: 80,
                }),
              );
            }
            await new Promise((done) => setTimeout(done, 30));
          }
          return Date.now();
        }, index),
      ),
    );
    const writes = (async () => {
      for (let i = 1; i <= 4; i++) {
        await new Promise((done) => setTimeout(done, 180));
        await f.write(documentHtml(i));
      }
    })();
    await reader.getByRole("button", { name: "Comment on preview", exact: true }).click();
    await reader
      .frameLocator("iframe")
      .locator("#track")
      .click({ position: { x: 80, y: 100 } });
    await reader
      .getByRole("textbox", { name: "Comment text", exact: true })
      .fill("Durable comment while eight cursors move");
    await reader.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot()).comments.map((comment) => comment.text), {
        timeout: 5000,
      })
      .toContain("Durable comment while eight cursors move");
    const stopped = await moving;
    await writes;
    await expect
      .poll(
        async () => {
          return reader.evaluate(
            (ids) =>
              ids
                .slice(1)
                .map((id, index) => {
                  const marker = document.querySelector<HTMLElement>(
                    `.cursor[data-session-id="${id}"]`,
                  );
                  const iframe = document.querySelector("iframe")!;
                  const rect = iframe
                    .contentDocument!.getElementById("track")!
                    .getBoundingClientRect();
                  const x = marker ? parseFloat(marker.style.left) / rect.width : -1;
                  return Boolean(
                    marker && !marker.hidden && Math.abs(x - (0.55 + (index + 1) * 0.02)) < 0.004,
                  );
                })
                .every(Boolean),
            sessions,
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await expect.poll(() => commandLatency.length).toBeGreaterThan(0);
    expect(Math.max(...commandLatency)).toBeLessThan(1500);
    expect(f.pressure().peakPresence).toBeLessThanOrEqual(16);
    expect(f.pressure().eventConnections).toBe(1);
    const lastVisible = Date.now();
    await new Promise((done) => setTimeout(done, 400));
    expect(f.pressure().activePresence).toBeLessThanOrEqual(2);
    await writeFile(
      "/tmp/plan-web-presence-eight-tabs-20261003.json",
      JSON.stringify(
        {
          tabs: 8,
          started,
          stopped,
          finalVisible: lastVisible,
          commandLatency,
          pressure: f.pressure(),
          posts: f.posted,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await f.evidence("/tmp/plan-web-presence-eight-tabs-failure-20261003.json");
    throw error;
  } finally {
    await f.close();
  }
}, 120_000);
