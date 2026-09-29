import { afterEach, expect, test } from "vite-plus/test";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { sharingPairUrl } from "@irudd-scope/protocol/sharing";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { Sharing } from "../apps/desktop/src/sharing.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { sharingFixture } from "./sharing-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const f = await sharingFixture();
  cleanup.push(f.close);
  let drop = "";
  let offline = false;
  const proxy = createServer((incoming, outgoing) => {
    if (offline) {
      outgoing.destroy();
      return;
    }
    const lost = incoming.method === drop;
    if (lost) drop = "";
    const upstream = request(
      new URL(incoming.url!, f.endpoint),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        if (lost) {
          response.resume();
          response.on("end", () => outgoing.destroy());
        } else {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        }
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  );
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not start.");
  const credentials = memoryCredentials();
  const store = new DesktopStore(join(f.directory, "desktop"), credentials);
  await store.load();
  cleanup.push(() => store.close());
  const desktop = new Sharing(store, () => {});
  cleanup.push(() => desktop.close());
  await desktop.start();
  await desktop.pair(
    sharingPairUrl(`http://127.0.0.1:${address.port}`, f.store.pairing(Date.now())),
  );
  const id = desktop.snapshot()[0].id;
  return {
    ...f,
    store,
    desktop,
    id,
    dropNext: (method: string) => {
      drop = method;
    },
    offline: (value: boolean) => {
      offline = value;
    },
  };
}

test("a lost upload acknowledgement is reconciled by operation ID for creation and refresh", async () => {
  const f = await fixture();
  const input = f.input("first");
  f.dropNext("PUT");
  const first = await f.desktop.write(f.id, input);
  expect(first.status).toBe("active");
  expect(f.desktop.snapshot()[0].connected).toBe(true);
  f.dropNext("PUT");
  const refreshed = await f.desktop.write(
    f.id,
    { ...input, content: Buffer.from("second").toString("base64") },
    first.id,
  );
  expect(refreshed).toMatchObject({ revision: 2, url: first.url, expiresAt: first.expiresAt });
  expect(refreshed.operationId).not.toBe(first.operationId);
  expect(f.desktop.snapshot()[0].connected).toBe(true);
  await expect(f.desktop.write(f.id, { ...input, content: "invalid!" }, first.id)).rejects.toThrow(
    "Invalid snapshot content",
  );
  expect(f.desktop.snapshot()[0].connected).toBe(true);
  expect(f.desktop.snapshot()[0].shares[0].revision).toBe(2);
});

test("a lost stop acknowledgement stays pending through desktop restart and then clears on retry", async () => {
  const f = await fixture();
  const share = await f.desktop.write(f.id, f.input());
  f.dropNext("DELETE");
  await expect(f.desktop.stop(f.id, share.id)).rejects.toThrow("unreachable");
  expect((await f.store.sharingDestinations())[0].pendingStops).toEqual([share.id]);
  expect(f.desktop.snapshot()[0].shares[0].status).toBe("active");
  f.offline(true);
  await f.desktop.close();
  const restored = new Sharing(f.store, () => {});
  cleanup.push(() => restored.close());
  await restored.start();
  await expect(restored.refreshStatus(f.id)).rejects.toThrow("unreachable");
  expect(restored.snapshot()[0].pendingStops).toEqual([share.id]);
  f.offline(false);
  await restored.refreshStatus(f.id);
  expect(restored.snapshot()[0].message).toBeUndefined();
  expect(restored.snapshot()[0].pendingStops).toEqual([]);
  expect(restored.snapshot()[0].shares[0].status).toBe("stopped");
});

test("removal keeps an unreachable service recorded until it acknowledges revocation", async () => {
  const f = await fixture();
  await f.desktop.write(f.id, f.input());
  f.offline(true);
  await expect(f.desktop.remove(f.id)).rejects.toThrow("unreachable");
  expect((await f.store.sharingDestinations())[0].removing).toBe(true);
  f.offline(false);
  await f.desktop.refreshStatus(f.id);
  expect(await f.store.sharingDestinations()).toEqual([]);
});

test("a duplicate service identity cannot replace unresolved shares or credentials", async () => {
  const f = await fixture();
  const share = await f.desktop.write(f.id, f.input());
  f.offline(true);
  await f.desktop.stop(f.id, share.id).catch(() => {});
  const duplicate = await sharingFixture();
  cleanup.push(duplicate.close);
  duplicate.store.setSetting("id", f.id);
  await expect(f.desktop.pair(duplicate.pairUrl())).rejects.toThrow("already paired");
  expect((await f.store.sharingDestinations())[0].pendingStops).toEqual([share.id]);
  expect(duplicate.store.getSetting("desktop")).toBeUndefined();
  f.offline(false);
  await f.desktop.refreshStatus(f.id);
  expect(f.desktop.snapshot()[0].connected).toBe(true);
});

test("desktop shutdown waits for an acknowledged pairing to finish saving its credential", async () => {
  const f = await sharingFixture();
  cleanup.push(f.close);
  const credentials = memoryCredentials();
  const write = credentials.write;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  credentials.write = async (value) => {
    entered.resolve();
    await release.promise;
    await write(value);
  };
  const store = new DesktopStore(join(f.directory, "desktop"), credentials);
  await store.load();
  cleanup.push(() => store.close());
  const desktop = new Sharing(store, () => {});
  cleanup.push(() => desktop.close());
  await desktop.start();
  const pairing = desktop.pair(f.pairUrl());
  await entered.promise;
  let closed = false;
  const closing = desktop.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    release.resolve();
  }
  await pairing;
  await closing;
  expect((await store.sharingDestinations())[0].id).toBe(desktop.snapshot()[0].id);
  expect(await store.sharingToken(desktop.snapshot()[0].id)).toBeTruthy();
});
