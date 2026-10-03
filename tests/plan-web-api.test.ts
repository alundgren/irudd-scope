import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startPlanWebServer } from "../apps/plan-web/src/backend/server.ts";
import type {
  Actor,
  CommandReceipt,
  PlanCommand,
  PlanEvent,
  PlanSnapshot,
  VersionPage,
} from "../apps/plan-web/src/contracts.ts";

const actor: Actor = { id: "tester", name: "Tester", kind: "agent" };
let directory: string;
let servers: Awaited<ReturnType<typeof startPlanWebServer>>[];
let children: ChildProcess[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scope-plan-web-test-"));
  servers = [];
  children = [];
});
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }),
  );
  await rm(directory, { recursive: true, force: true });
});
async function server() {
  const value = await startPlanWebServer({ databasePath: join(directory, "plan.sqlite") });
  servers.push(value);
  return value;
}
async function snapshot(url: string, name = "team"): Promise<PlanSnapshot> {
  const response = await fetch(`${url}/api/plans/${name}`);
  expect(response.status).toBe(200);
  return response.json();
}
async function command(
  url: string,
  value: PlanCommand,
  expectedStatus = 200,
): Promise<CommandReceipt> {
  const response = await fetch(`${url}/api/plans/team/commands`, {
    method: "POST",
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}
function html(requestId: string, baseHtmlRevision: number, value: string): PlanCommand {
  return { requestId, actor, kind: "html", baseHtmlRevision, html: value };
}
function comment(requestId: string): PlanCommand {
  return {
    requestId,
    actor,
    kind: "comment.add",
    anchor: { elementId: "title", quote: "Title", x: 0.5, y: 0.5 },
    text: requestId,
  };
}
async function readEvents(
  url: string,
  after: number,
  count: number,
  header?: string,
): Promise<PlanEvent[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await fetch(`${url}/api/plans/team/events?after=${after}`, {
      signal: abort.signal,
      headers: header ? { "Last-Event-ID": header } : {},
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: PlanEvent[] = [];
    while (events.length < count) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let delimiter: number;
      while ((delimiter = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        if (!block.includes("event: plan")) continue;
        const data = block.split("\n").find((line) => line.startsWith("data: "))!;
        const event = JSON.parse(data.slice(6)) as PlanEvent;
        expect(block).toContain(`id: ${event.revision}`);
        events.push(event);
      }
    }
    return events.slice(0, count);
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}
async function processServer(): Promise<string> {
  const child = spawn(process.execPath, ["apps/plan-web/dist/server/server-main.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PLAN_WEB_DB: join(directory, "plan.sqlite"), PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolveReady, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`Server startup timed out: ${errors}`)),
      20_000,
    );
    child.stderr!.on("data", (part) => {
      errors += part.toString();
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Server exited: ${errors}`));
    });
    child.stdout!.on("data", (part) => {
      output += part.toString();
      const match = /http:\/\/[^\s]+/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolveReady(match[0]);
      }
    });
  });
}

describe("collaborative plan HTTP API", () => {
  test("rebases separate HTML edits, rejects overlapping edits, and keeps comment revisions independent", async () => {
    const { url } = await server();
    await snapshot(url);
    const initial = await command(
      url,
      html("initial", 1, "<h1 id='title'>Alpha</h1><p id='body'>Bravo</p>"),
    );
    const added = await command(url, comment("discussion"));
    expect(added.snapshot.htmlRevision).toBe(initial.snapshot.htmlRevision);
    const first = await command(
      url,
      html("first", 2, "<h1 id='title'>Aardvark</h1><p id='body'>Bravo</p>"),
    );
    const second = await command(
      url,
      html("second", 2, "<h1 id='title'>Alpha</h1><p id='body'>Banana</p>"),
    );
    expect(second.rebased).toBe(true);
    expect(second.snapshot.html).toBe("<h1 id='title'>Aardvark</h1><p id='body'>Banana</p>");
    const rejected = await command(
      url,
      html("overlap", 2, "<h1 id='title'>Avocado</h1><p id='body'>Bravo</p>"),
      409,
    );
    expect(rejected.snapshot.html).toBe(second.snapshot.html);
    expect((await snapshot(url)).revision).toBe(second.revision);
    expect(first.snapshot.comments[0].text).toBe("discussion");
  });
  test("rebases three disjoint writers in beginning, end, middle order from one base", async () => {
    const { url } = await server();
    const base = "<h1>Beginning</h1><p>Middle</p><footer>Ending</footer>";
    await command(url, html("seed", 1, base));
    await command(url, html("beginning", 2, base.replace("Beginning", "A longer beginning")));
    await command(url, html("ending", 2, base.replace("Ending", "A new ending")));
    const final = await command(url, html("middle", 2, base.replace("Middle", "A shorter middle")));
    expect(final.rebased).toBe(true);
    expect(final.snapshot.html).toBe(
      "<h1>A longer beginning</h1><p>A shorter middle</p><footer>A new ending</footer>",
    );
    expect(final.snapshot.htmlRevision).toBe(5);
  });
  test("rejects stale intent matching an intermediate version after another writer replaces it", async () => {
    const { url } = await server();
    await command(url, html("start", 1, "Start"));
    await command(url, html("a", 2, "A"));
    const accepted = await command(url, html("b", 3, "B"));
    const stale = html("stale-a", 2, "A");
    const conflict = await command(url, stale, 409);
    expect(conflict.snapshot).toEqual(accepted.snapshot);
    expect((await snapshot(url)).revision).toBe(accepted.revision);
    await command(url, html("c", 4, "C"));
    expect(await command(url, stale, 409)).toEqual(conflict);
    expect((await snapshot(url)).html).toBe("C");
  });
  test.each([
    { title: "coincident inserts", accepted: "axbc", incoming: "aybc" },
    { title: "insertion at a deletion's beginning", accepted: "ac", incoming: "aybc" },
    { title: "insertion at a deletion's end", accepted: "ac", incoming: "abyc" },
  ])("rejects $title and preserves accepted HTML", async ({ accepted, incoming }) => {
    const { url } = await server();
    await command(url, html("boundary-seed", 1, "abc"));
    const current = await command(url, html("boundary-accepted", 2, accepted));
    const conflict = await command(url, html("boundary-incoming", 2, incoming), 409);
    expect(conflict.snapshot).toEqual(current.snapshot);
    expect((await snapshot(url)).html).toBe(accepted);
  });
  test("normalizes requests and makes accepted and rejected retries immutable across restart", async () => {
    let running = await server();
    const proposal = html("retry", 1, "<p>One</p>");
    const accepted = await command(running.url, proposal);
    await command(running.url, html("another", 2, "<p>Two</p>"));
    const reordered = {
      ...proposal,
      ignored: "not part of the command",
      actor: { kind: "agent", name: "Tester", id: "tester" },
    };
    const duplicate = await fetch(`${running.url}/api/plans/team/commands`, {
      method: "POST",
      body: JSON.stringify(reordered),
    });
    expect(await duplicate.json()).toEqual(accepted);
    await command(running.url, html("retry", 1, "<p>Different</p>"), 409);
    const failed = await command(running.url, html("stale", 2, "<p>Three</p>"), 409);
    await running.close();
    running = await server();
    expect(await command(running.url, proposal)).toEqual(accepted);
    expect(await command(running.url, html("stale", 2, "<p>Three</p>"), 409)).toEqual(failed);
    expect((await snapshot(running.url)).html).toBe("<p>Two</p>");
    const replay = await readEvents(running.url, 0, 3);
    expect(replay.map((event) => event.revision)).toEqual([1, 2, 3]);
    expect(replay[2].diff).toContain("-<p>One</p>");
    expect(replay[2].diff).toContain("+<p>Two</p>");
    expect((await readEvents(running.url, 0, 1, "2"))[0].revision).toBe(3);
  });
  test("rejects malformed Unicode without aliasing request receipts or Git HTML bytes", async () => {
    const { url } = await server();
    for (const requestId of ["\ud800", "\ud801", "\udc00"]) {
      const response = await fetch(`${url}/api/plans/team/commands`, {
        method: "POST",
        body: JSON.stringify({ ...comment("invalid"), requestId }),
      });
      expect(response.status).toBe(400);
    }
    const valid = comment("\ufffd");
    const accepted = await command(url, valid);
    await command(url, comment("after-valid"));
    expect(await command(url, valid)).toEqual(accepted);
    const current = await snapshot(url);
    const invalidHtml = await fetch(`${url}/api/plans/team/commands`, {
      method: "POST",
      body: JSON.stringify(html("invalid-html", current.htmlRevision, "<p>\ud800</p>")),
    });
    expect(invalidHtml.status).toBe(400);
    expect(await snapshot(url)).toEqual(current);
  });
  test("versions comment anchors, replies and resolution without removing disconnected anchors", async () => {
    const { url } = await server();
    const added = await command(url, comment("topic"));
    const commentId = added.snapshot.comments[0].id;
    const replied = await command(url, {
      requestId: "reply",
      actor,
      kind: "comment.reply",
      commentId,
      text: "A reply",
    });
    await command(url, {
      requestId: "resolved",
      actor,
      kind: "comment.resolve",
      commentId,
      resolved: true,
    });
    const removed = await command(
      url,
      html("remove-anchor", 1, "<p id='other'>Another element</p>"),
    );
    expect(removed.snapshot.comments[0]).toMatchObject({
      anchor: { elementId: "title" },
      resolved: true,
      replies: [{ text: "A reply" }],
    });
    const version = await fetch(`${url}/api/plans/team/versions/${added.revision}`).then(
      (response) => response.json(),
    );
    expect(version).toEqual(added.snapshot);
    const page = (await fetch(`${url}/api/plans/team/versions?limit=2`).then((response) =>
      response.json(),
    )) as VersionPage;
    expect(page.versions.map((event) => event.revision)).toEqual([5, 4]);
    expect(page.nextBefore).toBe(4);
    const next = (await fetch(
      `${url}/api/plans/team/versions?limit=2&before=${page.nextBefore}`,
    ).then((response) => response.json())) as VersionPage;
    expect(next.versions.map((event) => event.revision)).toEqual([3, 2]);
    expect(next.versions[0].snapshot).toEqual(replied.snapshot);
  });
  test("replays every revision during the snapshot/subscription race and observes another connection", async () => {
    const first = await server();
    const second = await server();
    const initial = await snapshot(first.url);
    const events = readEvents(first.url, initial.revision, 60);
    for (let index = 0; index < 60; index++) await command(second.url, comment(`race-${index}`));
    const received = await events;
    expect(received.map((event) => event.revision)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 2),
    );
    expect(received.at(-1)!.snapshot.comments).toHaveLength(60);
  });
  test("serializes competing server processes and deduplicates simultaneous retries", async () => {
    const urls = await Promise.all([processServer(), processServer()]);
    const page = await fetch(`${urls[0]}/plans/team`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    await snapshot(urls[0]);
    const base = Array.from(
      { length: 8 },
      (_, index) => `<p id="writer-${index}">Waiting ${index}</p>`,
    ).join("\n");
    await command(urls[0], html("parallel-seed", 1, base));
    const writers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        command(urls[index % 2], {
          ...html(
            `writer-${index}`,
            2,
            base.replace(`Waiting ${index}`, `Writer ${index} finished its planning update`),
          ),
          actor: {
            id: `writer-${index}`,
            name: `Writer ${index}`,
            kind: index < 6 ? "agent" : "human",
          },
        }),
      ),
    );
    expect(new Set(writers.map((item) => item.revision)).size).toBe(8);
    const htmlSnapshot = await snapshot(urls[0]);
    for (let index = 0; index < 8; index++)
      expect(htmlSnapshot.html).toContain(`Writer ${index} finished its planning update`);
    const accepted = await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        command(urls[index % 2], comment(`parallel-${index}`)),
      ),
    );
    expect(new Set(accepted.map((item) => item.revision)).size).toBe(80);
    const same = await Promise.all(urls.map((url) => command(url, comment("same-request"))));
    expect(same[0]).toEqual(same[1]);
    const current = await snapshot(urls[0]);
    expect(current.revision).toBe(91);
    expect(current.comments).toHaveLength(81);
    expect((await readEvents(urls[1], 0, 91)).at(-1)!.snapshot).toEqual(current);
  });
  test("starts competing services while the event loop releases a database journal lock", async () => {
    const blocker = new DatabaseSync(join(directory, "plan.sqlite"));
    blocker.exec("CREATE TABLE startup_lock (value TEXT); BEGIN; SELECT * FROM startup_lock");
    let settled = 0;
    const starting = Promise.allSettled(
      [
        server().then((value) => value.url),
        ...Array.from({ length: 4 }, () => processServer()),
      ].map((startup) =>
        startup.finally(() => {
          settled++;
        }),
      ),
    );
    try {
      await delay(300);
      expect(settled).toBe(0);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    const outcomes = await starting;
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    const urls = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<string>).value);
    const initial = await snapshot(urls[0]);
    expect(initial.revision).toBe(1);
    const receipts = await Promise.all(
      urls.map((url, index) => command(url, comment(`startup-${index}`))),
    );
    expect(new Set(receipts.map((receipt) => receipt.revision)).size).toBe(5);
    for (const url of urls) expect((await snapshot(url)).revision).toBe(6);
  });
  test("rejects a non-SQLite database without retrying initialization", async () => {
    const path = join(directory, "invalid.sqlite");
    await writeFile(path, "This is not a SQLite database.");
    await expect(startPlanWebServer({ databasePath: path })).rejects.toMatchObject({
      errcode: 26,
    });
  });
  test("keeps presence transient, replaces session leases, and expires old sessions", async () => {
    const { url } = await server();
    const initial = await snapshot(url);
    const publish = async (sessionId: string, x: number) => {
      const response = await fetch(`${url}/api/plans/team/presence`, {
        method: "POST",
        body: JSON.stringify({ sessionId, actor, elementId: "title", x, y: 0.5, updatedAt: 0 }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ sessionId: string; x: number; updatedAt: number }[]>;
    };
    await publish("alice", 0.1);
    expect(await publish("bob", 0.2)).toHaveLength(2);
    const updated = await publish("alice", 0.3);
    expect(updated).toHaveLength(2);
    expect(updated.find((entry) => entry.sessionId === "alice")!.x).toBe(0.3);
    expect(updated[0].updatedAt).toBeGreaterThan(0);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    try {
      expect((await publish("carol", 0.4)).map((entry) => entry.sessionId)).toEqual(["carol"]);
    } finally {
      clock.mockRestore();
    }
    expect(await snapshot(url)).toEqual(initial);
  });
  test("disconnects stalled readers while active readers replay without missing revisions", async () => {
    const { url } = await server();
    await command(url, html("large", 1, `<p>${"x".repeat(256 * 1024)}</p>`));
    for (let index = 0; index < 45; index++) await command(url, comment(`slow-${index}`));
    const slow = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const request = get(`${url}/api/plans/team/events?after=1`, (response) => {
        response.pause();
        resolveResponse(response);
      });
      request.on("error", reject);
    });
    try {
      const active = await readEvents(url, 1, 46);
      expect(active.map((event) => event.revision)).toEqual(
        Array.from({ length: 46 }, (_, index) => index + 2),
      );
      await delay(5500);
      const received: string[] = [];
      slow.on("data", (bytes) => received.push(bytes.toString()));
      const ended = new Promise<void>((resolveEnd) => {
        slow.once("close", resolveEnd);
      });
      slow.on("error", () => {});
      slow.resume();
      await Promise.race([
        ended,
        delay(5000).then(() => {
          throw new Error("Slow subscriber did not disconnect.");
        }),
      ]);
      expect(received.join("").match(/event: plan/g)?.length ?? 0).toBeLessThan(46);
      expect((await readEvents(url, 40, 7)).map((event) => event.revision)).toEqual([
        41, 42, 43, 44, 45, 46, 47,
      ]);
    } finally {
      slow.destroy();
    }
  });
  test("serves nested plan URLs and JavaScript/WASM assets and validates external inputs", async () => {
    const assets = join(directory, "assets");
    await mkdir(join(assets, "assets"), { recursive: true });
    await writeFile(join(assets, "index.html"), "<html><body>Browser entry</body></html>");
    await writeFile(join(assets, "assets", "worker.js"), "export const worker = true;");
    await writeFile(join(assets, "assets", "postgres.wasm"), new Uint8Array([0, 97, 115, 109]));
    const running = await startPlanWebServer({
      databasePath: join(directory, "plan.sqlite"),
      assetsDirectory: assets,
    });
    servers.push(running);
    const page = await fetch(`${running.url}/plans/new-team`);
    expect(await page.text()).toContain("Browser entry");
    expect((await snapshot(running.url, "new-team")).revision).toBe(1);
    expect((await fetch(`${running.url}/assets/worker.js`)).headers.get("content-type")).toContain(
      "javascript",
    );
    expect((await fetch(`${running.url}/assets/postgres.wasm`)).headers.get("content-type")).toBe(
      "application/wasm",
    );
    expect(
      (await fetch(`${running.url}/api/plans/team/commands`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(400);
    expect((await fetch(`${running.url}/api/plans/team/events?after=999`)).status).toBe(400);
    expect((await fetch(`${running.url}/api/plans/team/versions?limit=1000`)).status).toBe(400);
  });
});
