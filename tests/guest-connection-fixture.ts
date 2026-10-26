import type { Page, ElectronApplication } from "@playwright/test";
import { pairGuests } from "./guest-pairing-fixture.ts";
import { DatabaseSync } from "node:sqlite";
import { guestNetworkFixture } from "./guest-network-fixture.ts";
import { guestResponseFixture } from "./guest-response-fixture.ts";
import { guestCatalogChecks } from "./guest-catalog-checks.ts";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vite-plus/test";
import { desktopFixture } from "./desktop-fixture.ts";

export async function guestConnectionChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-cli-"));
  const events = join(directory, "events.jsonl");
  const routes = join(directory, "routes.json");
  await writeFile(routes, "{}");
  const network = await guestNetworkFixture(directory);
  const env = {
    ...network.env,
    SCOPE_GUEST_FIXTURE_EVENTS: events,
    SCOPE_GUEST_FIXTURE_ROUTES: routes,
  };
  const a = await desktopFixture({
    hideInitialPrompts: true,
    entry: network.entry,
    env: { ...env, SCOPE_GUEST_TEST_ADDRESS: "100.64.0.1" },
  });
  const b = await desktopFixture({
    hideInitialPrompts: true,
    showWindow: process.platform === "darwin",
    entry: network.entry,
    env: { ...env, SCOPE_GUEST_TEST_ADDRESS: "100.64.0.2" },
  });
  const responses = await guestResponseFixture();
  const left = await a.launch();
  let right: typeof left | undefined;
  try {
    right = await b.launch();
    const pageA = await left.firstWindow();
    const pageB = await right.firstWindow();
    const catalog = await guestCatalogChecks({ a, b, left, right, pageA, pageB, responses });
    async function settings(page: Page) {
      await page.getByRole("button", { name: "Search and controls" }).click();
      await page.getByLabel("Search artifacts", { exact: true }).fill("other scopes");
      await page.getByRole("button", { name: "Other Scopes Setting" }).click();
    }
    async function capture(page: Page, app: ElectronApplication, label: string) {
      if (!process.env.SCOPE_REVIEW_DIR) return;
      await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
      for (const appearance of ["light", "dark"]) {
        await page.getByLabel("Search settings").fill("appearance");
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await page.getByLabel("Search settings").fill("other scopes");
        for (const width of [1280, 640]) {
          await app.evaluate(
            ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820),
            width,
          );
          await page.screenshot({
            animations: "disabled",
            path: join(
              process.env.SCOPE_REVIEW_DIR!,
              `pairing-${label}-${appearance}-${width}.png`,
            ),
          });
        }
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 820),
      );
    }
    await settings(pageA);
    await settings(pageB);
    for (const page of [pageA, pageB]) {
      expect(await page.getByText("Tab copying", { exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Pairing link", { exact: true }).count()).toBe(0);
      expect(
        await page.getByRole("button", { name: "Copy guest connection", exact: true }).count(),
      ).toBe(0);
    }
    await pageA.getByLabel("This Scope's guest name").fill("Source Scope");
    await writeFile(network.state, JSON.stringify({ "100.64.0.1": { stopped: true } }));
    await pageA.getByRole("button", { name: "Create guest invitation", exact: true }).click();
    await pageA.getByRole("alert").filter({ hasText: "Tailscale is not connected" }).waitFor();
    await capture(pageA, left, "unavailable");
    for (const [fault, message] of [
      [{ invalidStatus: true }, "Scope could not read Tailscale's status response"],
      [{ commandFailed: true }, "Scope could not run Tailscale's status command"],
    ] as const) {
      await writeFile(network.state, JSON.stringify({ "100.64.0.1": fault }));
      await pageA.getByRole("button", { name: "Create guest invitation", exact: true }).click();
      await pageA.getByRole("alert").filter({ hasText: message }).waitFor();
    }
    for (const fault of [{ stopped: true }, { interfaceMissing: true }, { occupied: true }]) {
      await writeFile(network.state, JSON.stringify({ "100.64.0.1": fault }));
      await expect(
        pageA.evaluate(() => window.scope.createGuestInvitation("Source Scope")),
      ).rejects.toThrow();
    }
    await writeFile(network.state, "{}");
    await pageA.getByRole("button", { name: "Create guest invitation", exact: true }).focus();
    await pageA.keyboard.press("Enter");
    await pageA.getByRole("button", { name: "Copy guest invitation", exact: true }).waitFor();
    const cancelled = (await pageA.evaluate(() => window.scope.guestPairingStatus()))!;
    await capture(pageA, left, "invitation");
    await pageA.getByRole("button", { name: "Copy guest invitation", exact: true }).click();
    await expect
      .poll(() => left.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(/^scope-guest:\/\/v2/);
    const cancelledLink = await left.evaluate(({ clipboard }) => clipboard.readText());
    await pageA.getByRole("button", { name: "Cancel guest pairing", exact: true }).click();
    await pageA.getByText("Guest pairing cancelled.", { exact: true }).waitFor();
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), cancelledLink);
    await pageB.getByLabel("This Scope's guest name").fill("Guest Scope");
    await pageB.getByRole("button", { name: "Paste guest invitation", exact: true }).click();
    await pageB
      .getByRole("button", { name: "Allow guest sharing with Source Scope", exact: true })
      .waitFor();
    await pageB
      .getByRole("button", { name: "Allow guest sharing with Source Scope", exact: true })
      .click();
    await pageB
      .getByRole("alert")
      .filter({ hasText: "Create or paste a new invitation" })
      .waitFor();
    expect(await pageB.getByRole("alert").count()).toBe(1);
    expect(await pageB.getByRole("alert").innerText()).toContain(
      "Create or paste a new invitation",
    );
    await capture(pageB, right, "failed-pairing");
    expect((await pageB.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(0);
    const expired = JSON.parse(Buffer.from(cancelledLink.split("#")[1]!, "base64url").toString());
    expired.expiresAt = Date.now() - 1;
    await right.evaluate(
      ({ clipboard }, link) => clipboard.writeText(link),
      "scope-guest://v2/#" + Buffer.from(JSON.stringify(expired)).toString("base64url"),
    );
    await expect(
      pageB.evaluate(() => window.scope.inspectGuestInvitation("Guest Scope")),
    ).rejects.toThrow("expired");
    for (const address of ["8.8.8.8", "http://100.64.0.1", "127.0.0.1"]) {
      const invalid = {
        ...expired,
        expiresAt: Date.now() + 60000,
        endpoint: { address, port: 12345 },
      };
      await right.evaluate(
        ({ clipboard }, link) => clipboard.writeText(link),
        "scope-guest://v2/#" + Buffer.from(JSON.stringify(invalid)).toString("base64url"),
      );
      await expect(
        pageB.evaluate(() => window.scope.inspectGuestInvitation("Guest Scope")),
      ).rejects.toThrow("invalid");
    }
    const longName =
      "Guest Scope for a travelling design team with a long device name used for keyboard and narrow window checks";
    const expiring = await pageA.evaluate(() => window.scope.createGuestInvitation("Source Scope"));
    await left.evaluate(() => {
      const clock = Date.now;
      (globalThis as unknown as { scopeOriginalClock: typeof Date.now }).scopeOriginalClock = clock;
      Date.now = () => clock() + 5 * 60_000 + 1;
    });
    await expect
      .poll(() =>
        pageA.evaluate(() => window.scope.guestPairingStatus()).then((value) => value?.state),
      )
      .toBe("expired");
    await expect(
      pageA.evaluate((id) => window.scope.copyGuestInvitation(id), expiring.id),
    ).rejects.toThrow();
    await left.evaluate(() => {
      Date.now = (
        globalThis as unknown as { scopeOriginalClock: typeof Date.now }
      ).scopeOriginalClock;
    });
    // Each return-check phase fits its budget, while their sum exceeds ten seconds.
    const slow = await pageA.evaluate(() => window.scope.createGuestInvitation("Source Scope"));
    await pageA.evaluate((id) => window.scope.copyGuestInvitation(id), slow.id);
    const slowLink = await left.evaluate(({ clipboard }) => clipboard.readText());
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), slowLink);
    await pageB.evaluate(() => window.scope.inspectGuestInvitation("Guest Scope"));
    await writeFile(
      network.state,
      JSON.stringify({
        "100.64.0.1": { statusDelayMs: 3000 },
        "100.64.0.2": { verifyDelayMs: 8000 },
      }),
    );
    try {
      await pageB.evaluate((id) => window.scope.approveGuestPairing(id), slow.id);
      expect((await pageA.evaluate(() => window.scope.guestPairingStatus()))?.state).toBe("review");
      expect((await pageB.evaluate(() => window.scope.guestPairingStatus()))?.state).toBe(
        "pending",
      );
      expect((await pageA.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(0);
      expect((await pageB.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(0);
    } finally {
      await writeFile(network.state, "{}");
      await pageA.evaluate((id) => window.scope.cancelGuestPairing(id), slow.id);
      await pageB.evaluate((id) => window.scope.cancelGuestPairing(id), slow.id);
    }
    // Hold the real completion reply while the receiver saves and then cancels its protected pair.
    const unfinished = await pageA.evaluate(() =>
      window.scope.createGuestInvitation("Source Scope"),
    );
    await pageA.evaluate((id) => window.scope.copyGuestInvitation(id), unfinished.id);
    const unfinishedLink = await left.evaluate(({ clipboard }) => clipboard.readText());
    const unfinishedEndpoint = JSON.parse(
      Buffer.from(unfinishedLink.split("#")[1]!, "base64url").toString(),
    ).endpoint;
    responses.target(unfinishedEndpoint.port);
    await writeFile(routes, JSON.stringify({ [unfinishedEndpoint.port]: responses.port }));
    responses.holdPairingCompletion();
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), unfinishedLink);
    await pageB.evaluate(() => window.scope.inspectGuestInvitation("Guest Scope"));
    await pageB.evaluate((id) => window.scope.approveGuestPairing(id), unfinished.id);
    await pageA.evaluate((id) => window.scope.approveGuestPairing(id), unfinished.id);
    await expect.poll(responses.pairingCompletionHeld, { timeout: 10000 }).toBe(true);
    const cancellationDb = new DatabaseSync(join(b.settingsDirectory, "desktop.db"));
    try {
      cancellationDb.exec(`CREATE TRIGGER reject_pair_cancel BEFORE UPDATE ON preferences
        WHEN NEW.name = 'guest-settings' AND json_extract(NEW.document, '$.enabled."${unfinished.id}"') = 0
        BEGIN SELECT RAISE(FAIL, 'Synthetic cancellation failure'); END`);
      await pageB.getByRole("button", { name: "Cancel guest pairing", exact: true }).click();
      await pageB.getByRole("button", { name: "Retry cancellation", exact: true }).waitFor();
      expect((await pageB.evaluate(() => window.scope.guestPairingStatus()))?.state).toBe(
        "revocation-failed",
      );
      expect(await pageB.getByText("Guest pairing cancelled.", { exact: true }).count()).toBe(0);
      await expect(
        pageB.evaluate((id) => window.scope.setGuestAccess(id, true), unfinished.id),
      ).rejects.toThrow();
      await capture(pageB, right, "cancellation-failed");
      cancellationDb.exec("DROP TRIGGER reject_pair_cancel");
      await pageB.getByRole("button", { name: "Retry cancellation", exact: true }).focus();
      await pageB.keyboard.press("Enter");
      await pageB.getByText("Guest pairing cancelled.", { exact: true }).waitFor();
      await capture(pageB, right, "cancellation-saved");
    } finally {
      cancellationDb.exec("DROP TRIGGER IF EXISTS reject_pair_cancel");
      cancellationDb.close();
      responses.releasePairingCompletion();
    }
    const paired = await pairGuests(
      left,
      right,
      pageA,
      pageB,
      ["Source Scope", longName],
      async (invitation) => {
        responses.target(invitation.endpoint.port);
        await writeFile(routes, JSON.stringify({ [invitation.endpoint.port]: responses.port }));
      },
      async (page, peerName) => {
        const app = page === pageA ? left : right!;
        const button = page.getByRole("button", {
          name: "Allow guest sharing with " + peerName,
          exact: true,
        });
        await button.waitFor();
        if (page === pageA) await capture(pageB, right!, "pending");
        await capture(page, app, page === pageA ? "issuer-consent-long-name" : "receiver-consent");
        await button.focus();
        await page.keyboard.press("Enter");
      },
    );
    await pageA.getByRole("button", { name: "Close", exact: true }).click();
    await pageB.getByRole("button", { name: "Close", exact: true }).click();
    const id = paired.id;
    const decoded = paired.invitation;
    const pairingSecret = paired.key;
    const receiverEndpoint = paired.claim.endpoint;
    expect(decoded.endpoint.address).toBe("100.64.0.1");
    const rendererStatus = await pageA.evaluate(async () =>
      JSON.stringify({
        devices: await window.scope.guestDevices(),
        status: await window.scope.guestPairingStatus(),
      }),
    );
    expect(rendererStatus).not.toContain(pairingSecret);
    expect(rendererStatus).not.toContain(decoded.secret);
    expect(rendererStatus).not.toContain(decoded.endpoint.address);

    const pairMessage = { claim: paired.claim, nonce: randomBytes(32).toString("base64url") };
    const { secret: invitationSecret, ...publicInvitation } = paired.invitation;
    const pairMac = createHmac("sha256", Buffer.from(invitationSecret, "base64url"))
      .update(
        "scope-guest:pair-claim:" +
          JSON.stringify({ invitation: publicInvitation, value: pairMessage }),
      )
      .digest("base64url");
    for (const headers of [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", Origin: "https://example.test" },
    ] as Record<string, string>[]) {
      expect(
        (
          await fetch(`http://127.0.0.1:${decoded.endpoint.port}/guest/pair-claim`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...pairMessage, mac: pairMac }),
          })
        ).status,
      ).toBe(403);
    }
    // The consumed invitation cannot create another pair, including after successful consent.
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), paired.link);
    await expect(
      pageB.evaluate(() => window.scope.inspectGuestInvitation("Guest Scope")),
    ).rejects.toThrow("already paired");
    const stateA = () =>
      pageA.evaluate(() => window.scope.guestStatus()).then((status) => status.peers[0]?.state);
    const stateB = () =>
      pageB.evaluate(() => window.scope.guestStatus()).then((status) => status.peers[0]?.state);
    await expect.poll(stateA, { timeout: 20000 }).toBe("connected");
    await expect.poll(stateB).toBe("connected");
    const rows = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { kind: string; pid: number; port: number; address?: string },
      );
    expect(new Set(rows.filter((row) => row.kind === "listen").map((row) => row.address))).toEqual(
      new Set(["100.64.0.1", "100.64.0.2"]),
    );
    expect(
      rows.some((row) => row.kind === "/guest/challenge" && row.port === decoded.endpoint.port),
    ).toBe(true);
    expect(
      rows.some((row) => row.kind === "/guest/hello" && row.port === decoded.endpoint.port),
    ).toBe(true);
    expect(rows.filter((row) => row.kind === "/guest/challenge").length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row.kind === "/guest/hello").length).toBeGreaterThanOrEqual(2);
    await pageA.evaluate((id) => window.scope.retryGuest(id), id);
    await expect
      .poll(async () => (await readFile(events, "utf8")).includes('"/guest/identity"'))
      .toBe(true);
    await catalog.connected();
    const endpoint = decoded.endpoint as { port: number; address: string };
    expect((await fetch(`http://127.0.0.1:${endpoint.port}/guest/identity`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${endpoint.port}/v1/artifacts`)).status).toBe(403);
    responses.offline(true);
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateB, { timeout: 30000 }).toBe("offline");
    responses.offline(false);
    await pageA.evaluate((id) => window.scope.retryGuest(id), id);
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateA, { timeout: 30000 }).toBe("connected");
    await expect.poll(stateB, { timeout: 30000 }).toBe("connected");
    await catalog.reconnected();
    // A session-only client cannot call a capability it did not negotiate.
    const challenge = await fetch(`http://127.0.0.1:${endpoint.port}/guest/challenge`).then(
      (response) => response.json(),
    );
    const devices = await pageB.evaluate(() => window.scope.guestDevices());
    const hello = {
      version: 2,
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
    await settings(pageA);
    await pageA.getByRole("button", { name: "Disable guest sharing", exact: true }).click();
    await expect.poll(stateA).toBe("disabled");
    await capture(pageA, left, "disabled");
    const revoked = await fetch(`http://127.0.0.1:${endpoint.port}/guest/identity`, {
      headers: { Authorization: "Bearer " + session },
    })
      .then((response) => response.status)
      .catch((error: unknown) => (error as { cause?: { code?: string } }).cause?.code);
    expect([403, "ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"]).toContain(revoked);
    await pageB.evaluate((id) => window.scope.retryGuest(id), id);
    await expect.poll(stateB, { timeout: 20000 }).toBe("offline");
    await catalog.revoked();
    expect((await pageA.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(1);
    await pageA.getByRole("button", { name: "Forget guest " + longName, exact: true }).click();
    await pageA.getByRole("button", { name: "Keep paired", exact: true }).waitFor();
    await capture(pageA, left, "forget-confirmation");
    await pageA.getByRole("button", { name: "Keep paired", exact: true }).click();
    expect((await pageA.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(1);
    await pageA.getByRole("button", { name: "Forget guest " + longName, exact: true }).click();
    await pageA.getByRole("button", { name: "Forget guest Scope", exact: true }).click();
    await expect
      .poll(() => pageA.evaluate(() => window.scope.guestDevices()).then((d) => d.peers.length))
      .toBe(0);
    await pageA.getByRole("button", { name: "Close", exact: true }).click();
    await right.close();
    right = await b.launch();
    await catalog.restarted(await right.firstWindow(), right);
  } finally {
    await right?.close();
    await responses.close();
    await left.close();
    await Promise.all(
      [directory, a.directory, b.directory].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
}
