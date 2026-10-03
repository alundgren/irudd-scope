import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startPlanWebServer } from "../apps/plan-web/src/backend/server.ts";
import {
  planApi,
  planEventsUrl,
  planStreamLimits,
  type Actor,
  type CommandReceipt,
  type PlanCommand,
  type PlanEvent,
  type PlanStreamPresence,
  type PlanSubscription,
} from "../apps/plan-web/src/contracts.ts";

const actor: Actor = { id: "writer", name: "Writer", kind: "agent" };
let directory: string;
let servers: Awaited<ReturnType<typeof startPlanWebServer>>[];
let readers: { close(): void }[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "scope-plan-stream-"));
  servers = [];
  readers = [];
});
afterEach(async () => {
  for (const reader of readers) reader.close();
  await Promise.all(servers.map((server) => server.close()));
  await rm(directory, { recursive: true, force: true });
});
async function server() {
  const value = await startPlanWebServer({ databasePath: join(directory, "plans.sqlite") });
  servers.push(value);
  return value;
}
async function command(url: string, name: string, value: PlanCommand): Promise<CommandReceipt> {
  const response = await fetch(`${url}${planApi(name)}/commands`, {
    method: "POST",
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(200);
  return response.json();
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
type Frame = { event: string; id?: string; data: unknown };
async function stream(url: string, subscriptions: PlanSubscription[], lastId?: string) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20_000);
  const response = await fetch(`${url}${planEventsUrl(subscriptions)}`, {
    signal: abort.signal,
    headers: lastId ? { "Last-Event-ID": lastId } : {},
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const value = {
    close() {
      clearTimeout(timeout);
      abort.abort();
    },
    async next(): Promise<Frame> {
      for (;;) {
        const delimiter = buffer.indexOf("\n\n");
        if (delimiter !== -1) {
          const block = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          const lines = block.split("\n");
          const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
          if (!event || !data) continue;
          return {
            event,
            id: lines.find((line) => line.startsWith("id: "))?.slice(4),
            data: JSON.parse(data),
          };
        }
        const result = await reader.read();
        if (result.done) throw new Error("Event stream closed before the expected frame.");
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
  };
  readers.push(value);
  return value;
}
async function plans(reader: Awaited<ReturnType<typeof stream>>, count: number) {
  const result: (Frame & { data: PlanEvent })[] = [];
  while (result.length < count) {
    const frame = await reader.next();
    if (frame.event === "plan") result.push(frame as Frame & { data: PlanEvent });
  }
  return result;
}

describe("multiplexed durable plan stream", () => {
  test("replays independent plan cursors, routes presence, and reconnects with an opaque cursor map", async () => {
    const { url } = await server();
    const blue = "blue / café";
    const green = "green 🙂";
    await command(url, blue, comment("blue-1"));
    await command(url, green, comment("green-1"));
    await command(url, blue, comment("blue-2"));
    const reader = await stream(url, [
      { name: blue, after: 1 },
      { name: green, after: 0 },
    ]);
    const initial = await plans(reader, 4);
    expect(
      initial
        .filter((frame) => frame.data.snapshot.name === blue)
        .map((frame) => frame.data.revision),
    ).toEqual([2, 3]);
    expect(
      initial
        .filter((frame) => frame.data.snapshot.name === green)
        .map((frame) => frame.data.revision),
    ).toEqual([1, 2]);
    const lastId = initial.at(-1)!.id!;
    expect(lastId).toMatch(/^v1\.[\x21-\x7e]+$/);
    expect(JSON.parse(decodeURIComponent(lastId.slice(3)))).toEqual({ [blue]: 3, [green]: 2 });
    for (const name of [blue, green]) {
      const response = await fetch(`${url}${planApi(name)}/presence`, {
        method: "POST",
        body: JSON.stringify({ sessionId: name, actor, elementId: "title", x: 0.2, y: 0.4 }),
      });
      expect(response.status).toBe(200);
    }
    const presence = new Map<string, PlanStreamPresence>();
    while (presence.size < 2) {
      const frame = await reader.next();
      if (frame.event !== "presence") continue;
      expect(frame.id).toBeUndefined();
      const payload = frame.data as PlanStreamPresence;
      if (payload.people.length) presence.set(payload.name, payload);
    }
    expect(presence.get(blue)!.people[0].sessionId).toBe(blue);
    expect(presence.get(green)!.people[0].sessionId).toBe(green);
    reader.close();
    await command(url, green, comment("green-2"));
    await command(url, blue, comment("blue-3"));
    const resumed = await stream(
      url,
      [
        { name: blue, after: 0 },
        { name: green, after: 0 },
      ],
      lastId,
    );
    const next = await plans(resumed, 2);
    expect(next.map((frame) => [frame.data.snapshot.name, frame.data.revision])).toEqual([
      [blue, 4],
      [green, 3],
    ]);
  });
  test("deduplicates repeated subscriptions and retries and ignores cursors for removed plans", async () => {
    const { url } = await server();
    const request = comment("same");
    const accepted = await command(url, "one", request);
    expect(await command(url, "one", request)).toEqual(accepted);
    const reader = await stream(url, [
      { name: "one", after: 1 },
      { name: "one", after: 0 },
    ]);
    expect((await plans(reader, 2)).map((frame) => frame.data.revision)).toEqual([1, 2]);
    reader.close();
    const header = `v1.${encodeURIComponent(JSON.stringify({ one: 1, removed: 1000 }))}`;
    const narrowed = await stream(url, [{ name: "one", after: 0 }], header);
    expect((await plans(narrowed, 1))[0].data.revision).toBe(2);
  });
  test("observes interleaved commits from another SQLite connection with no replay/live gap", async () => {
    const first = await server();
    const second = await server();
    await fetch(`${first.url}${planApi("alpha")}`);
    await fetch(`${first.url}${planApi("beta")}`);
    const reader = await stream(first.url, [
      { name: "alpha", after: 1 },
      { name: "beta", after: 1 },
    ]);
    const receiving = plans(reader, 80);
    const publishing = (async () => {
      for (let index = 0; index < 80; index++)
        await command(second.url, index % 2 ? "beta" : "alpha", comment(`race-${index}`));
    })();
    const [received] = await Promise.all([receiving, publishing]);
    for (const name of ["alpha", "beta"])
      expect(
        received
          .filter((frame) => frame.data.snapshot.name === name)
          .map((frame) => frame.data.revision),
      ).toEqual(Array.from({ length: 40 }, (_, index) => index + 2));
    const finalId = received.at(-1)!.id!;
    reader.close();
    await first.close();
    await second.close();
    const restarted = await server();
    await command(restarted.url, "alpha", comment("after-restart-alpha"));
    await command(restarted.url, "beta", comment("after-restart-beta"));
    const resumed = await stream(
      restarted.url,
      [
        { name: "alpha", after: 0 },
        { name: "beta", after: 0 },
      ],
      finalId,
    );
    expect(
      (await plans(resumed, 2)).map((frame) => [frame.data.snapshot.name, frame.data.revision]),
    ).toEqual([
      ["alpha", 42],
      ["beta", 42],
    ]);
  });
  test("delivers a quiet plan's write while another plan has a thousand replay events", async () => {
    const { url } = await server();
    await command(url, "hot", {
      requestId: "hot-seed",
      actor,
      kind: "html",
      baseHtmlRevision: 1,
      html: "hot",
    });
    for (let index = 0; index < 1000; index++)
      await command(url, "hot", {
        requestId: `hot-${index}`,
        actor,
        kind: "html",
        baseHtmlRevision: index + 2,
        html: "hot",
      });
    const [reader] = await Promise.all([
      stream(url, [
        { name: "hot", after: 0 },
        { name: "quiet", after: 0 },
      ]),
      command(url, "quiet", comment("quiet-live")),
    ]);
    const seen: PlanEvent[] = [];
    for (;;) {
      const frame = await reader.next();
      if (frame.event !== "plan") continue;
      const event = frame.data as PlanEvent;
      seen.push(event);
      if (event.snapshot.name === "quiet" && event.revision === 2) break;
      if (seen.length > 100)
        throw new Error("Hot replay prevented the quiet plan from receiving its write.");
    }
    expect(seen.some((event) => event.snapshot.name === "hot")).toBe(true);
    expect(seen.filter((event) => event.snapshot.name === "hot").at(-1)!.revision).toBeLessThan(
      1002,
    );
  });
  test("updates every plan's presence while five plans have a thousand pending revisions", async () => {
    const { url } = await server();
    const names = ["first", "second", "third", "fourth", "fifth"];
    const source = `<p>${"x".repeat(2048)}</p>`;
    for (const name of names) {
      await command(url, name, {
        requestId: `${name}-seed`,
        actor,
        kind: "html",
        baseHtmlRevision: 1,
        html: source,
      });
      for (let index = 0; index < 1000; index++)
        await command(url, name, {
          requestId: `${name}-${index}`,
          actor,
          kind: "html",
          baseHtmlRevision: index + 2,
          html: source,
        });
    }
    const reader = await stream(
      url,
      names.map((name) => ({ name, after: 0 })),
    );
    const initiallyPresent = new Set<string>();
    const revisions = new Map<string, number>();
    const observe = (frame: Frame) => {
      if (frame.event === "plan") {
        const event = frame.data as PlanEvent;
        revisions.set(event.snapshot.name, event.revision);
      }
    };
    while (initiallyPresent.size < names.length) {
      const frame = await reader.next();
      observe(frame);
      if (frame.event === "presence") initiallyPresent.add((frame.data as PlanStreamPresence).name);
    }
    expect([...revisions.values()].some((revision) => revision < 1002)).toBe(true);
    const response = await fetch(`${url}${planApi("fifth")}/presence`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "live-person", actor, elementId: "title", x: 0.2, y: 0.4 }),
    });
    expect(response.status).toBe(200);
    for (;;) {
      const frame = await reader.next();
      observe(frame);
      if (frame.event !== "presence") continue;
      const present = frame.data as PlanStreamPresence;
      if (
        present.name === "fifth" &&
        present.people.some((person) => person.sessionId === "live-person")
      )
        break;
    }
    expect([...revisions.values()].some((revision) => revision < 1002)).toBe(true);
  }, 60_000);
  test("disconnects a blocked multiplexed reader while another reader completes replay", async () => {
    const { url } = await server();
    await command(url, "large", {
      requestId: "large",
      actor,
      kind: "html",
      baseHtmlRevision: 1,
      html: `<p>${"x".repeat(256 * 1024)}</p>`,
    });
    for (let index = 0; index < 45; index++) await command(url, "large", comment(`large-${index}`));
    await command(url, "small", comment("small"));
    const subscriptions = [
      { name: "large", after: 1 },
      { name: "small", after: 0 },
    ];
    const slow = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const request = get(`${url}${planEventsUrl(subscriptions)}`, (response) => {
        response.pause();
        resolveResponse(response);
      });
      request.on("error", reject);
    });
    readers.push({
      close() {
        slow.destroy();
      },
    });
    const active = await stream(url, subscriptions);
    const replay = await plans(active, 48);
    expect(
      replay
        .filter((frame) => frame.data.snapshot.name === "large")
        .map((frame) => frame.data.revision),
    ).toEqual(Array.from({ length: 46 }, (_, index) => index + 2));
    expect(
      replay
        .filter((frame) => frame.data.snapshot.name === "small")
        .map((frame) => frame.data.revision),
    ).toEqual([1, 2]);
    await delay(5500);
    const chunks: string[] = [];
    slow.on("data", (bytes) => chunks.push(bytes.toString()));
    const ended = new Promise<void>((resolveEnd) => {
      slow.once("close", resolveEnd);
    });
    slow.on("error", () => {});
    slow.resume();
    await Promise.race([
      ended,
      delay(5000).then(() => {
        throw new Error("Slow multiplexed reader stayed connected.");
      }),
    ]);
    expect(chunks.join("").match(/event: plan/g)?.length ?? 0).toBeLessThan(48);
    const reconnect = await stream(url, [
      { name: "large", after: 44 },
      { name: "small", after: 1 },
    ]);
    const resumed = await plans(reconnect, 4);
    expect(
      resumed
        .filter((frame) => frame.data.snapshot.name === "large")
        .map((frame) => frame.data.revision),
    ).toEqual([45, 46, 47]);
    expect(
      resumed
        .filter((frame) => frame.data.snapshot.name === "small")
        .map((frame) => frame.data.revision),
    ).toEqual([2]);
  });
  test("bounds original query encoding and the combined reconnect header before decoding", async () => {
    const { url } = await server();
    const encodeEveryCharacter = (value: string) =>
      Array.from(value)
        .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("");
    const overQuery = JSON.stringify([{ name: "valid", after: 0, ignored: "a".repeat(1400) }]);
    const rawQuery = encodeEveryCharacter(overQuery);
    expect(encodeURIComponent(overQuery).length).toBeLessThan(planStreamLimits.encodedQueryLength);
    expect(rawQuery.length).toBeGreaterThan(planStreamLimits.encodedQueryLength);
    const rejectedQuery = await fetch(`${url}/api/events?subscriptions=${rawQuery}`);
    expect(rejectedQuery.status).toBe(400);
    const combinedJson = JSON.stringify([{ name: "valid", after: 0, ignored: "a".repeat(1300) }]);
    const combinedRaw = encodeEveryCharacter(combinedJson);
    const cursorMap = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`removed-${index}`.padEnd(200, "a"), 0]),
    );
    const header = `v1.${encodeURIComponent(JSON.stringify(cursorMap))}`;
    expect(combinedRaw.length).toBeLessThan(planStreamLimits.encodedQueryLength);
    expect(encodeURIComponent(combinedJson).length + header.length).toBeLessThan(
      planStreamLimits.requestLength,
    );
    expect(combinedRaw.length + header.length).toBeGreaterThan(planStreamLimits.requestLength);
    const rejectedCombined = await fetch(`${url}/api/events?subscriptions=${combinedRaw}`, {
      headers: { "Last-Event-ID": header },
    });
    expect(rejectedCombined.status).toBe(400);
  });
  test("validates subscription counts, names, cursors, encodings and request limits", async () => {
    const { url } = await server();
    const request = (subscriptions: unknown, lastId?: string) =>
      fetch(
        `${url}/api/events?subscriptions=${encodeURIComponent(JSON.stringify(subscriptions))}`,
        { headers: lastId ? { "Last-Event-ID": lastId } : {} },
      );
    for (const subscriptions of [
      [],
      {},
      [{ name: " ", after: 0 }],
      [{ name: "\ud800", after: 0 }],
      [{ name: "\ud801", after: 0 }],
      [{ name: "\udc00", after: 0 }],
      [{ name: "valid", after: -1 }],
      [{ name: "valid", after: 0.5 }],
      [{ name: "valid", after: 999 }],
      Array.from({ length: 21 }, (_, index) => ({ name: `plan-${index}`, after: 0 })),
    ])
      expect((await request(subscriptions)).status).toBe(400);
    for (const header of [
      "1",
      "v1.%",
      "v1.null",
      `v1.${encodeURIComponent(JSON.stringify({ valid: -1 }))}`,
      `v1.${"x".repeat(8193)}`,
    ])
      expect((await request([{ name: "valid", after: 0 }], header)).status).toBe(400);
    const replacement = await stream(url, [{ name: "\ufffd", after: 0 }]);
    expect((await plans(replacement, 1))[0].data.snapshot.name).toBe("\ufffd");
    replacement.close();
    const wide = Array.from({ length: 20 }, (_, index) => ({
      name: `${index}${"🙂".repeat(80)}`,
      after: 0,
    }));
    expect(() => planEventsUrl(wide)).toThrow("URL limit");
    const boundedWide = [
      { name: "🙂".repeat(100), after: 0 },
      { name: "x".repeat(200), after: 0 },
    ];
    const initial = await stream(url, boundedWide);
    const first = await plans(initial, 2);
    const header = first.at(-1)!.id!;
    initial.close();
    const reconnect = await fetch(`${url}${planEventsUrl(boundedWide)}`, {
      headers: { "Last-Event-ID": header },
      signal: AbortSignal.timeout(1000),
    });
    expect(reconnect.status).toBe(200);
    await reconnect.body!.cancel();
  });
});
