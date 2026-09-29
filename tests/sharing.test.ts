import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SharingStore } from "../apps/sharing/src/store.ts";
import { SharingService, type Connect } from "../apps/sharing/src/service.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { Sharing } from "../apps/desktop/src/sharing.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { SHARE_LIFETIME_MS, type Share } from "@irudd-scope/protocol/sharing";
import { sharingFixture } from "./sharing-fixture.ts";
import { dnsAnswer } from "../apps/sharing/src/network.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(connect?: Connect) {
  const f = await sharingFixture(connect);
  cleanup.push(f.close);
  await f.pair();
  return f;
}
const origin = (port: number, share: Share) =>
  `http://127.0.0.1:${port}${new URL(share.url!).pathname}`;

test("a public origin serves unchanged HTML and HEAD, with no public management or form handlers", async () => {
  const f = await fixture();
  const html =
    '<!doctype html><form method="post"><input name="x"></form><script>window.example=1</script>';
  const id = randomUUID();
  const created = await f.request(`/v1/shares/${id}`, "PUT", f.input(html));
  expect(created.status).toBe(200);
  const share: Share = await created.json();
  const url = origin(f.ports[0], share);
  const page = await fetch(url);
  expect(await page.text()).toBe(html);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("content-security-policy")).toBeNull();
  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    expect((await fetch(url, { method })).status).toBe(405);
  for (const path of [
    "/",
    "/v1/pair",
    "/v1/shares",
    "/../data/sharing.sqlite",
    `${new URL(url).pathname}?submit=1`,
  ]) {
    expect((await fetch(new URL(path, url))).status).toBe(404);
  }
  expect((await fetch(url, { headers: { "Content-Length": "0" } })).status).toBe(200);
  expect(f.store.record(id)?.share.revision).toBe(1);
  expect(
    (await f.request("/v1/shares", "GET", undefined, { Origin: "https://example.invalid" })).status,
  ).toBe(403);
  expect((await fetch(`${f.endpoint}/v1/shares`)).status).toBe(401);
  await f.request(`/v1/shares/${id}`, "DELETE");
  await expect(fetch(url)).rejects.toThrow();
  expect(f.store.record(id)?.content).toBeNull();
});

test("refresh preserves URL and deadline, rejects stale writes, and keeps the last good snapshot on failure", async () => {
  const f = await fixture();
  const id = randomUUID();
  const input = f.input("first");
  const first: Share = await (await f.request(`/v1/shares/${id}`, "PUT", input)).json();
  expect(await (await f.request(`/v1/shares/${id}`, "PUT", input)).json()).toEqual(first);
  f.advance(30_000);
  const refresh = {
    ...input,
    operationId: randomUUID(),
    expectedRevision: 1,
    content: Buffer.from("second").toString("base64"),
  };
  const next: Share = await (await f.request(`/v1/shares/${id}`, "PUT", refresh)).json();
  expect(next).toMatchObject({ url: first.url, expiresAt: first.expiresAt, revision: 2 });
  expect(f.ports).toHaveLength(1);
  expect(
    (await f.request(`/v1/shares/${id}`, "PUT", { ...refresh, operationId: randomUUID() })).status,
  ).toBe(409);
  expect(
    (
      await f.request(`/v1/shares/${id}`, "PUT", {
        ...refresh,
        operationId: randomUUID(),
        expectedRevision: 2,
        content: "not base64",
      })
    ).status,
  ).toBe(400);
  expect(await (await fetch(origin(f.ports[0], next))).text()).toBe("second");
});

test.each(["wall", "elapsed", "backwards"])(
  "%s clock expiry stops the origin and never renews a share",
  async (clock) => {
    const f = await fixture();
    const id = randomUUID();
    const input = f.input();
    const share: Share = await (await f.request(`/v1/shares/${id}`, "PUT", input)).json();
    if (clock === "wall") f.advance(SHARE_LIFETIME_MS, 1);
    else if (clock === "elapsed") f.advance(1, SHARE_LIFETIME_MS);
    else f.advance(-1, 1);
    const response = await fetch(origin(f.ports[0], share)).catch(() => undefined);
    expect(response?.status ?? 410).toBe(410);
    await expect.poll(() => f.stops.length).toBe(1);
    expect(
      (
        await f.request(`/v1/shares/${id}`, "PUT", {
          ...input,
          operationId: randomUUID(),
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect(f.store.record(id)?.share.status).toBe("expired");
  },
);

test("each share gets its own origin, the limit is five, and a connector failure ends its share", async () => {
  const f = await fixture();
  const shares: Share[] = [];
  for (let i = 0; i < 5; i++)
    shares.push(await (await f.request(`/v1/shares/${randomUUID()}`, "PUT", f.input())).json());
  expect(new Set(shares.map((share) => new URL(share.url!).origin)).size).toBe(5);
  expect((await f.request(`/v1/shares/${randomUUID()}`, "PUT", f.input())).status).toBe(409);
  f.disconnected[0]();
  await expect.poll(() => f.store.record(shares[0].id)?.share.status).toBe("failed");
  expect((await f.request(`/v1/shares/${randomUUID()}`, "PUT", f.input())).status).toBe(200);
});

test("stop cancels tunnel startup and rejects an upload that arrives after the stop", async () => {
  let entered = false;
  const f = await fixture(
    async (_port, signal) =>
      new Promise((_resolve, reject) => {
        entered = true;
        signal.addEventListener("abort", () => reject(new Error("Canceled")), { once: true });
      }),
  );
  const id = randomUUID();
  const creating = f.request(`/v1/shares/${id}`, "PUT", f.input());
  await expect.poll(() => entered).toBe(true);
  expect((await f.request(`/v1/shares/${id}`, "DELETE")).status).toBe(200);
  expect((await creating).status).toBe(503);
  const late = randomUUID();
  await f.request(`/v1/shares/${late}`, "DELETE");
  expect((await f.request(`/v1/shares/${late}`, "PUT", f.input())).status).toBe(409);
});

test("restart purges stored active bytes and never starts a public connector", async () => {
  const f = await fixture();
  const id = randomUUID();
  const file = join(f.directory, "crash.sqlite");
  const old = new SharingStore(file);
  old.create(id, f.input(), Buffer.from("crash snapshot"), "fingerprint", Date.now());
  old.close();
  const restored = new SharingStore(file);
  let connects = 0;
  const service = new SharingService(restored, async () => {
    connects++;
    throw new Error("Unexpected tunnel");
  });
  try {
    expect(service.status().shares[0]).toMatchObject({ status: "interrupted", url: null });
    expect(restored.record(id)?.content).toBeNull();
    expect(connects).toBe(0);
  } finally {
    await service.close();
    restored.close();
  }
});

test("unpair revokes the credential, closes all origins, and supports a lost removal acknowledgement", async () => {
  const f = await fixture();
  const id = randomUUID();
  const share: Share = await (await f.request(`/v1/shares/${id}`, "PUT", f.input())).json();
  expect((await f.request("/v1/pair", "DELETE")).status).toBe(200);
  expect((await f.request("/v1/shares")).status).toBe(401);
  expect((await f.request("/v1/pair", "DELETE")).status).toBe(200);
  await expect(fetch(origin(f.ports[0], share))).rejects.toThrow();
  const reopened = new SharingStore(f.filename);
  expect(reopened.getSetting("desktop")).toBeUndefined();
  reopened.close();
});

test("upgrade requests cannot turn a content listener into a websocket", async () => {
  const f = await fixture();
  const share: Share = await (
    await f.request(`/v1/shares/${randomUUID()}`, "PUT", f.input())
  ).json();
  const result = await new Promise<string>((resolve) => {
    const req = request(origin(f.ports[0], share), {
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("error", () => resolve("closed"));
    req.end();
  });
  expect(result).toBe("closed");
});

test("desktop records keep stop requests across a restart and keep credentials out of SQLite", async () => {
  const f = await sharingFixture();
  cleanup.push(f.close);
  const credentials = memoryCredentials();
  const store = new DesktopStore(join(f.directory, "desktop"), credentials);
  await store.load();
  cleanup.push(() => store.close());
  const sharing = new Sharing(store, () => {});
  await sharing.start();
  cleanup.push(() => sharing.close());
  await sharing.pair(f.pairUrl());
  const id = sharing.snapshot()[0].id;
  const input = f.input();
  const share = await sharing.write(id, input);
  const token = (await credentials.read()).sharingTokens![id];
  for (const suffix of ["", "-wal"])
    expect(
      (await readFile(`${store.filename}${suffix}`).catch(() => Buffer.alloc(0))).includes(
        Buffer.from(token),
      ),
    ).toBe(false);
  await sharing.close();
  expect(await (await fetch(origin(f.ports[0], share))).text()).toBe("<h1>Frozen copy</h1>");
  await store.saveSharing({ ...sharing.snapshot()[0], pendingStops: [share.id] });
  const restored = new Sharing(store, () => {});
  cleanup.push(() => restored.close());
  await restored.start();
  await expect
    .poll(() => restored.snapshot()[0]?.shares.find((item) => item.id === share.id)?.status)
    .toBe("stopped");
  expect((await store.sharingDestinations())[0].pendingStops).toEqual([]);
  await restored.remove(id);
  expect(await store.sharingDestinations()).toEqual([]);
});

test("DNS only answers the exact tunnel records and never forwards arbitrary names", () => {
  const query = (name: string, type: number) => {
    const header = Buffer.from("123401000001000000000000", "hex");
    const labels = name
      .split(".")
      .flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
    const end = Buffer.alloc(5);
    end.writeUInt16BE(type, 1);
    end.writeUInt16BE(1, 3);
    return Buffer.concat([header, ...labels, end]);
  };
  expect(dnsAnswer(query("region1.v2.argotunnel.com", 1))!.readUInt16BE(6)).toBe(10);
  expect(dnsAnswer(query("_v2-origintunneld._tcp.argotunnel.com", 33))!.readUInt16BE(6)).toBe(2);
  expect(dnsAnswer(query("private.region1.v2.argotunnel.com", 1))![3] & 15).toBe(3);
  expect(dnsAnswer(query("example.com", 16))![3] & 15).toBe(3);
  expect(dnsAnswer(Buffer.alloc(4))).toBeUndefined();
});

test.each(["expiry", "stop"])(
  "%s interrupts an in-progress response instead of finishing a slow transfer",
  async (reason) => {
    const f = await fixture();
    const id = randomUUID();
    const input = f.input();
    const total = 32 * 1024 * 1024;
    const share: Share = await (
      await f.request(`/v1/shares/${id}`, "PUT", {
        ...input,
        content: Buffer.alloc(total, 65).toString("base64"),
      })
    ).json();
    let received = 0;
    let resume: () => void = () => {};
    let began: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const ended = new Promise<boolean>((resolve, reject) => {
      const req = request(origin(f.ports[0], share), (response) => {
        response.once("data", (bytes) => {
          received += bytes.length;
          response.pause();
          resume = () => response.resume();
          began();
        });
        response.on("aborted", () => resolve(false));
        response.on("end", () => resolve(true));
        response.on("error", () => resolve(false));
      });
      req.on("error", reject);
      req.end();
    });
    await started;
    if (reason === "expiry") {
      f.advance(SHARE_LIFETIME_MS);
      f.service.checkExpiry();
    } else await f.request(`/v1/shares/${id}`, "DELETE");
    resume();
    expect(await ended).toBe(false);
    expect(received).toBeLessThan(total);
  },
);

test.each(["stop", "connector", "expiry", "unpair"])(
  "a refresh uploading during %s cannot revive the share",
  async (reason) => {
    const f = await sharingFixture();
    cleanup.push(f.close);
    const { token } = await f.pair();
    const id = randomUUID();
    const input = f.input("first");
    const share: Share = await (await f.request(`/v1/shares/${id}`, "PUT", input)).json();
    const refresh = {
      ...input,
      operationId: randomUUID(),
      expectedRevision: 1,
      content: Buffer.from("late").toString("base64"),
    };
    const body = JSON.stringify(refresh);
    const pending = request(`${f.endpoint}/v1/shares/${id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    const response = new Promise<number>((resolve, reject) => {
      pending.on("error", reject);
      pending.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
    });
    cleanup.push(() => {
      pending.destroy();
    });
    await new Promise<void>((resolve) => pending.write(body.slice(0, -1), () => resolve()));
    expect(await (await fetch(origin(f.ports[0], share))).text()).toBe("first");
    if (reason === "stop") await f.request(`/v1/shares/${id}`, "DELETE");
    else if (reason === "connector") f.disconnected[0]();
    else if (reason === "expiry") {
      f.advance(SHARE_LIFETIME_MS);
      f.service.checkExpiry();
    } else await f.request("/v1/pair", "DELETE");
    pending.end(body.slice(-1));
    expect(await response).toBe(reason === "unpair" ? 401 : 409);
    await expect(fetch(origin(f.ports[0], share))).rejects.toThrow();
    expect(f.store.record(id)?.content).toBeNull();
  },
);

test("HTML encoding metadata is preserved without an overriding HTTP charset", async () => {
  const f = await fixture();
  const input = f.input();
  const bytes = Buffer.concat([
    Buffer.from('<meta charset="windows-1252"><p>caf'),
    Buffer.from([0xe9]),
    Buffer.from("</p>"),
  ]);
  const share: Share = await (
    await f.request(`/v1/shares/${randomUUID()}`, "PUT", {
      ...input,
      content: bytes.toString("base64"),
    })
  ).json();
  const response = await fetch(origin(f.ports[0], share));
  expect(response.headers.get("content-type")).toBe("text/html");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

test.each(["stopped", "shares", "settings"])(
  "a failed write to %s cannot prevent listener and connector teardown",
  async (table) => {
    const f = await fixture();
    const id = randomUUID();
    const share: Share = await (await f.request(`/v1/shares/${id}`, "PUT", f.input())).json();
    const db = new DatabaseSync(f.filename);
    try {
      const operation = table === "stopped" ? "INSERT" : table === "shares" ? "UPDATE" : "DELETE";
      db.exec(
        `CREATE TRIGGER deny_writes BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END;`,
      );
      const response = await f.request(
        table === "settings" ? "/v1/pair" : `/v1/shares/${id}`,
        "DELETE",
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("database failed");
      await expect(fetch(origin(f.ports[0], share))).rejects.toThrow();
      expect(f.stops).toHaveLength(1);
      expect((await f.request("/v1/shares")).status).toBe(503);
      expect((await f.request(`/v1/shares/${randomUUID()}`, "PUT", f.input())).status).toBe(503);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS deny_writes");
      db.close();
    }
  },
);
