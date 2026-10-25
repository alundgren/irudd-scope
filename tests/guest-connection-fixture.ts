import { guestCli } from "./guest-cli.ts";
import { guestResponseFixture } from "./guest-response-fixture.ts";
import { guestCatalogChecks } from "./guest-catalog-checks.ts";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect } from "vite-plus/test";
import { syntheticCli } from "./synthetic-cli.ts";
import { desktopFixture } from "./desktop-fixture.ts";

export async function guestConnectionChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-cli-"));
  const events = join(directory, "events.jsonl");
  const routes = join(directory, "routes.json");
  await writeFile(routes, "{}");
  await syntheticCli(directory, "tailcat", guestCli);
  const env = {
    PATH: directory + delimiter + process.env.PATH,
    SCOPE_GUEST_FIXTURE_EVENTS: events,
    SCOPE_GUEST_FIXTURE_ROUTES: routes,
  };
  const a = await desktopFixture({ hideInitialPrompts: true, env });
  const b = await desktopFixture({ hideInitialPrompts: true, env });
  const trap = createServer((_request, response) => response.writeHead(403).end());
  await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
  const trapPort = (trap.address() as { port: number }).port;
  const responses = await guestResponseFixture();
  const left = await a.launch();
  let right: typeof left | undefined;
  try {
    right = await b.launch();
    const pageA = await left.firstWindow();
    const pageB = await right.firstWindow();
    const catalog = await guestCatalogChecks({ a, b, left, right, pageA, pageB, responses });
    const invitation = await pageA.evaluate(() => window.scope.createPairing("Source Scope"));
    await pageA.evaluate((id) => window.scope.copyPairingSecret(id), invitation.id);
    const pairingSecret = await left.evaluate(({ clipboard }) => clipboard.readText());
    await pageB.evaluate((input) => window.scope.pairScope(input), {
      url: invitation.url,
      secret: pairingSecret,
      name: "Guest Scope",
    });
    const id = (await pageA.evaluate(() => window.scope.transferDevices())).peers[0]!.id;
    expect((await pageB.evaluate(() => window.scope.guestStatus())).peers[0]).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, true), id);
    await pageA.evaluate((id) => window.scope.copyGuestLink(id), id);
    const link = await left.evaluate(({ clipboard }) => clipboard.readText());
    const decoded = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString());
    const { mac: _mac, ...routed } = decoded;
    responses.target(decoded.endpoint.port);
    await writeFile(
      routes,
      JSON.stringify({ [trapPort]: responses.port, [decoded.endpoint.port]: responses.port }),
    );
    routed.endpoint = { ...routed.endpoint, port: trapPort };
    const mac = createHmac("sha256", Buffer.from(pairingSecret, "base64url"))
      .update("scope-guest:link:" + JSON.stringify(routed))
      .digest("base64url");
    const routedLink =
      "scope-guest://v1/#" + Buffer.from(JSON.stringify({ ...routed, mac })).toString("base64url");
    // The signed destination rejects direct HTTP. Only SOCKS maps it to the peer.
    expect((await fetch(`http://127.0.0.1:${trapPort}/guest/challenge`)).status).toBe(403);
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), routedLink);
    await expect(pageB.evaluate((id) => window.scope.connectGuestLink(id), id)).rejects.toThrow(
      "disabled",
    );
    await pageB.evaluate((id) => window.scope.setGuestAccess(id, true), id);
    await pageB.evaluate((id) => window.scope.connectGuestLink(id), id);
    const stateA = () =>
      pageA.evaluate(() => window.scope.guestStatus()).then((status) => status.peers[0]?.state);
    const stateB = () =>
      pageB.evaluate(() => window.scope.guestStatus()).then((status) => status.peers[0]?.state);
    await expect.poll(stateA, { timeout: 20000 }).toBe("connected");
    await expect.poll(stateB).toBe("connected");
    await right.evaluate(({ clipboard }) => clipboard.writeText("scope-guest://v1/#invalid"));
    await expect(pageB.evaluate((id) => window.scope.connectGuestLink(id), id)).rejects.toThrow(
      "invalid",
    );
    expect(await stateB()).toBe("connected");
    const rows = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; pid: number; port: number });
    // These events are emitted only after HTTP bytes cross the SOCKS tunnel.
    // Merely completing SOCKS CONNECT while HTTP uses a local socket cannot pass.
    expect(rows.some((row) => row.kind === "/guest/challenge" && row.port === trapPort)).toBe(true);
    expect(rows.some((row) => row.kind === "/guest/hello" && row.port === trapPort)).toBe(true);
    expect(rows.filter((row) => row.kind === "/guest/challenge").length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row.kind === "/guest/hello").length).toBeGreaterThanOrEqual(2);
    await pageA.evaluate((id) => window.scope.retryGuest(id), id);
    await expect
      .poll(async () => (await readFile(events, "utf8")).includes('"/guest/identity"'))
      .toBe(true);
    await catalog.connected();
    const servers = rows.filter((row) => row.kind === "serve");
    const endpoint = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString())
      .endpoint as { port: number; address: string };
    expect((await fetch(`http://127.0.0.1:${endpoint.port}/guest/identity`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${endpoint.port}/v1/artifacts`)).status).toBe(403);
    const tailcat = servers.find((row) => row.port === endpoint.port)!;
    process.kill(tailcat.pid, "SIGKILL");
    await expect
      .poll(
        async () =>
          (await readFile(events, "utf8")).split("\n").filter((line) => line.includes('"serve"'))
            .length,
        { timeout: 30000 },
      )
      .toBeGreaterThan(servers.length);
    await pageA.evaluate((id) => window.scope.retryGuest(id), id);
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateA, { timeout: 30000 }).toBe("connected");
    await expect.poll(stateB, { timeout: 30000 }).toBe("connected");
    await pageA.evaluate((id) => window.scope.copyGuestLink(id), id);
    const restarted = await left.evaluate(({ clipboard }) => clipboard.readText());
    expect(
      JSON.parse(Buffer.from(restarted.split("#")[1]!, "base64url").toString()).endpoint,
    ).toEqual(endpoint);
    await catalog.reconnected();
    // A session-only older client cannot call a capability it did not negotiate.
    await pageB.evaluate((id) => window.scope.copyGuestLink(id), id);
    const receiverLink = await right.evaluate(({ clipboard }) => clipboard.readText());
    const receiverEndpoint = JSON.parse(
      Buffer.from(receiverLink.split("#")[1]!, "base64url").toString(),
    ).endpoint;
    const challenge = await fetch(`http://127.0.0.1:${endpoint.port}/guest/challenge`).then(
      (response) => response.json(),
    );
    const devices = await pageB.evaluate(() => window.scope.transferDevices());
    const hello = {
      version: 1,
      pairId: id,
      deviceId: devices.deviceId,
      targetId: devices.peers[0]!.deviceId,
      name: "Older synthetic Scope",
      nonce: randomBytes(32).toString("base64url"),
      epoch: randomUUID(),
      targetEpoch: challenge.epoch,
      challenge: challenge.challenge,
      enabled: true,
      capabilities: ["session"],
      endpoint: receiverEndpoint,
      timestamp: Date.now(),
    };
    const proof = createHmac("sha256", Buffer.from(pairingSecret, "base64url"))
      .update("scope-guest:hello:" + JSON.stringify(hello))
      .digest("base64url");
    const authenticated = await fetch(`http://127.0.0.1:${endpoint.port}/guest/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello, mac: proof }),
    });
    expect(authenticated.status).toBe(200);
    const session = (await authenticated.json()).session;
    const unsupported = await fetch(`http://127.0.0.1:${endpoint.port}/guest/catalog`, {
      method: "POST",
      headers: { Authorization: "Bearer " + session, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unsupported.status).toBe(404);
    expect(
      (
        await fetch(`http://127.0.0.1:${endpoint.port}/guest/mutation-prepare`, {
          method: "POST",
          headers: { Authorization: "Bearer " + session, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(await unsupported.json()).toEqual({ error: "Unsupported guest operation." });
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, false), id);
    expect(await stateA()).toBe("disabled");
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateB, { timeout: 20000 }).toBe("offline");
    await catalog.revoked();
    expect((await pageA.evaluate(() => window.scope.transferDevices())).peers).toHaveLength(1);
    await pageA.evaluate((id) => window.scope.forgetScope(id), id);
    expect((await pageA.evaluate(() => window.scope.transferDevices())).peers).toHaveLength(0);
    await right.close();
    right = await b.launch();
    await catalog.restarted(await right.firstWindow(), right);
  } finally {
    await right?.close();
    await responses.close();
    trap.closeAllConnections();
    await new Promise<void>((resolve) => trap.close(() => resolve()));
    await left.close();
    await Promise.all(
      [directory, a.directory, b.directory].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
}
