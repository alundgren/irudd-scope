import { afterEach, expect, test, vi } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { decode, decodeLocalConnection } from "@irudd-scope/protocol";
import {
  PairReceipt,
  readPairingUrl,
  RelayEvent,
  type RelayRequest,
} from "@irudd-scope/protocol/remote";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const metadata = {
  expectedRevision: 0,
  title: "Synthetic buffered report",
  kind: "text",
  fileName: "report.txt",
  mediaType: "text/plain",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-relay-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = await HubState.open(join(directory, "hub"));
  cleanup.push(() => state.close());
  const connectionFile = join(directory, "connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  cleanup.push(hub.close);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const pairing = readPairingUrl(state.pairUrl());
  const paired = await fetch(`${hub.url}/v1/pair`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pairing.token}` },
    body: JSON.stringify({ name: "Synthetic relay Mac" }),
  });
  expect(paired.status).toBe(200);
  const desktop = decode(PairReceipt, await paired.json());
  const request = (path: string, init: RequestInit = {}, token = local.token) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${hub.url}${path}`, { ...init, headers });
  };
  const status = async () => (await request("/v1/hub/status")).json();
  const queue = async () => (await request("/v1/hub/queue")).json();
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [resolve("packages/cli/dist/main.mjs"), ...args],
          {
            env: {
              ...process.env,
              SCOPE_CONNECTION_FILE: connectionFile,
              SCOPE_TOKEN: undefined,
              SCOPE_ENDPOINT: undefined,
              SCOPE_TOKEN_FILE: undefined,
            },
            timeout: 30_000,
          },
        )
      ).stdout,
    );
  const openRelay = async (waking = false) => {
    const controller = new AbortController();
    const response = await request(
      "/v1/relay/events",
      { signal: controller.signal, headers: waking ? { "Scope-Relay-Wake": "1" } : {} },
      desktop.token,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const events: RelayEvent[] = [];
    let wake: (() => void) | undefined;
    const reading = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) !== -1) {
          events.push(decode(RelayEvent, JSON.parse(pending.slice(0, boundary))));
          pending = pending.slice(boundary + 1);
          wake?.();
        }
      }
    })().catch(() => {});
    const close = async () => {
      controller.abort();
      await reading;
    };
    cleanup.push(close);
    const next = async (type: RelayEvent["type"]) => {
      while (true) {
        const index = events.findIndex((event) => event.type === type);
        if (index !== -1) return events.splice(index, 1)[0];
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    };
    await next("ready");
    return {
      waitingRequests: () => events.filter((event) => event.type === "request").length,
      next: async () => (await next("request")) as RelayRequest,
      cancel: () => next("cancel"),
      close,
    };
  };
  const body = (id: string) => request(`/v1/relay/requests/${id}/body`, {}, desktop.token);
  const answer = (id: string, status: number, value: unknown) =>
    request(
      `/v1/relay/requests/${id}/response`,
      {
        method: "POST",
        headers: { "scope-response-status": String(status) },
        body: JSON.stringify(value),
      },
      desktop.token,
    );
  return {
    state,
    request,
    status,
    queue,
    cli,
    openRelay,
    body,
    answer,
    client: new ScopeClient(hub.url, local.token),
  };
}

test("delivery retries back off to five minutes and new publications cannot bypass the cooldown", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const f = await fixture();
  await f.client.publishOrQueue("retrying", metadata, Buffer.from("Retained bytes"));
  const relay = await f.openRelay();
  let event = await relay.next();
  for (const [index, waitMs] of [
    3000, 6000, 12_000, 24_000, 48_000, 96_000, 192_000, 300_000, 300_000,
  ].entries()) {
    expect((await f.answer(event.id, 503, { error: "Synthetic temporary failure." })).status).toBe(
      200,
    );
    await f.client.publishOrQueue(
      `new-arrival-${index}`,
      metadata,
      Buffer.from("New queued bytes"),
    );
    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(relay.waitingRequests()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    event = await relay.next();
    expect(event).toMatchObject({ method: "GET", path: "/v1/artifacts/retrying" });
  }
  expect((await f.queue()).items).toHaveLength(10);
});

test("ordinary reconnects respect cooldown and a Mac wake resumes delivery immediately", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const f = await fixture();
  await f.client.publishOrQueue("wake-up", metadata, Buffer.from("Waiting for the Mac"));
  const old = await f.openRelay();
  const event = await old.next();
  expect((await f.answer(event.id, 503, { error: "Synthetic temporary failure." })).status).toBe(
    200,
  );
  expect(old.waitingRequests()).toBe(0);
  await old.close();
  await vi.waitFor(async () => expect(await f.status()).toMatchObject({ connected: false }));
  const normal = await f.openRelay();
  expect(normal.waitingRequests()).toBe(0);
  await normal.close();
  await vi.waitFor(async () => expect(await f.status()).toMatchObject({ connected: false }));
  const replacement = await f.openRelay(true);
  expect((await replacement.next()).path).toBe("/v1/artifacts/wake-up");
});

test("an unstarted write timeout retires the relay and the next CLI publication queues", async () => {
  const f = await fixture();
  const relay = await f.openRelay();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const writing = f.request("/v1/artifacts/stalled/tab", {
    method: "POST",
    body: '{"expectedRevision":0}',
  });
  expect(await relay.next()).toMatchObject({ method: "POST" });
  const other = f.request("/v1/artifacts");
  expect(await relay.next()).toMatchObject({ method: "GET" });
  await vi.advanceTimersByTimeAsync(30_000);
  const result = await writing;
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({
    error: "The Mac did not respond in time. Check the artifact before retrying.",
  });
  expect(await f.status()).toMatchObject({ connected: false, pairedMac: "Synthetic relay Mac" });
  const interrupted = await other;
  expect(interrupted.status).toBe(503);
  expect(await interrupted.json()).toEqual({
    error: "Scope on the Mac disconnected. Check the artifact before retrying an uncertain write.",
  });
  vi.useRealTimers();
  expect(await f.cli("text", "Safe buffered bytes", "--id", "after-timeout")).toMatchObject({
    id: "after-timeout",
    queued: true,
  });
  expect((await f.queue()).items).toHaveLength(1);
  expect((await f.queue()).items[0]).toMatchObject({ id: "after-timeout", status: "queued" });
});

test.each(["GET", "started write"])("a %s timeout leaves the relay connected", async (mode) => {
  const f = await fixture();
  const relay = await f.openRelay();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const result =
    mode === "GET"
      ? f.request("/v1/artifacts")
      : f.request("/v1/artifacts/started/tab", { method: "POST", body: '{"expectedRevision":0}' });
  const event = await relay.next();
  if (mode === "started write")
    expect(await (await f.body(event.id)).json()).toEqual({ expectedRevision: 0 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await result).status).toBe(503);
  expect(await f.status()).toMatchObject({ connected: true });
});

test("caller cancellation does not retire an unstarted relay request", async () => {
  const f = await fixture();
  const relay = await f.openRelay();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const controller = new AbortController();
  const writing = f.request("/v1/artifacts/canceled/tab", {
    method: "POST",
    body: '{"expectedRevision":0}',
    signal: controller.signal,
  });
  const rejected = expect(writing).rejects.toMatchObject({ name: "AbortError" });
  const event = await relay.next();
  controller.abort();
  await rejected;
  expect(await relay.cancel()).toMatchObject({ id: event.id });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await f.status()).toMatchObject({ connected: true });
});

test.each([false, true])(
  "buffered delivery timeout with body fetched=%s preserves the queue",
  async (started) => {
    const f = await fixture();
    await f.client.publishOrQueue(
      "buffered-timeout",
      metadata,
      Buffer.from("Retained synthetic bytes"),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const relay = await f.openRelay();
    const read = await relay.next();
    expect(read).toMatchObject({ method: "GET", path: "/v1/artifacts/buffered-timeout" });
    expect((await f.answer(read.id, 404, { error: "Not found." })).status).toBe(200);
    const write = await relay.next();
    expect(write).toMatchObject({ method: "POST", path: "/v1/artifacts/buffered-timeout/tab" });
    if (started) expect(await (await f.body(write.id)).json()).toEqual({ expectedRevision: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await f.status()).toMatchObject({ connected: started });
    expect((await f.queue()).items).toMatchObject([{ id: "buffered-timeout", status: "queued" }]);
    expect(f.state.queue.get("buffered-timeout")?.writing).toBe(0);
    expect(f.state.queue.content("buffered-timeout").toString()).toBe("Retained synthetic bytes");
  },
);

test("an unanswered buffered-delivery GET does not retire the relay", async () => {
  const f = await fixture();
  await f.client.publishOrQueue("buffered-read", metadata, Buffer.from("Read timeout bytes"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const relay = await f.openRelay();
  expect(await relay.next()).toMatchObject({ method: "GET" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await f.status()).toMatchObject({ connected: true });
  expect((await f.queue()).items).toMatchObject([{ id: "buffered-read", status: "queued" }]);
});

test("a canceled old session deadline cannot retire its replacement", async () => {
  const f = await fixture();
  const old = await f.openRelay();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const writing = f.request("/v1/artifacts/old-session/tab", {
    method: "POST",
    body: '{"expectedRevision":0}',
  });
  await old.next();
  await old.close();
  expect((await writing).status).toBe(503);
  const replacement = await f.openRelay();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await f.status()).toMatchObject({ connected: true });
  const read = f.request("/v1/artifacts/missing");
  const event = await replacement.next();
  expect((await f.answer(event.id, 404, { error: "Not found." })).status).toBe(200);
  expect((await read).status).toBe(404);
});
