import { pairGuests } from "./guest-pairing-fixture.ts";
import { guestNetworkFixture } from "./guest-network-fixture.ts";
import { guestPlanDeadlines } from "./guest-plan-deadlines.ts";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { guestPlanNetwork, lostPreparation } from "./guest-plan-network.ts";
import { expect } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readPlan, type PlanDocument } from "@irudd-scope/protocol/plan";
import { desktopFixture } from "./desktop-fixture.ts";
import { guestResponseFixture } from "./guest-response-fixture.ts";
import { cliMain, spawnedHub } from "./hub-fixture.ts";

const exec = promisify(execFile);
const proposal: PlanDocument = {
  version: 1,
  title: "Shared request plan",
  overviewHtml:
    '<!doctype html><style>body{background:#242424;color:#eee;font:18px system-ui;padding:32px}button{font:inherit;padding:12px}section{margin:32px 0}</style><h1>Owner request plan</h1><button onclick="this.textContent=\'Inspected\'">Inspect request</button><section data-plan-goal="goal"></section><section data-plan-procedure="check"></section><div style="height:2400px">Original full proposal</div><script>document.body.dataset.check=window.scopePlan.data.checks[0].expectation</script>',
  goals: [{ id: "goal", outcome: "Requests preserve their original input." }],
  checks: [
    {
      id: "check",
      label: "Keep the request",
      goalIds: ["goal"],
      expectation: "One complete result survives restart.",
      conditions: "Use two synthetic desktops.",
      method: "Submit one request, restart each desktop, and compare the result.",
      kind: "agent",
      placement: "work",
    },
  ],
  items: [
    {
      id: "prepare",
      title: "Prepare requests",
      outcome: "The fixture is ready.",
      goalIds: ["goal"],
      checkIds: [],
      dependsOn: [],
    },
    {
      id: "implement",
      title: "Preserve requests",
      outcome: "The complete result remains inspectable.",
      goalIds: ["goal"],
      checkIds: ["check"],
      dependsOn: ["prepare"],
    },
  ],
};

export async function guestPlanChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-plans-"));
  await guestPlanNetwork(directory);
  const routes = join(directory, "routes.json");
  await writeFile(routes, "{}");
  const network = await guestNetworkFixture(directory);
  const env = {
    ...network.env,
    SCOPE_GUEST_FIXTURE_EVENTS: join(directory, "events.jsonl"),
    SCOPE_GUEST_FIXTURE_ROUTES: routes,
  };
  const a = await desktopFixture({
    hideInitialPrompts: true,
    entry: network.entry,
    env: { ...env, SCOPE_GUEST_TEST_ADDRESS: "100.64.0.1" },
  });
  const b = await desktopFixture({
    hideInitialPrompts: true,
    entry: network.entry,
    env: { ...env, SCOPE_GUEST_TEST_ADDRESS: "100.64.0.2" },
  });
  let left = await a.launch(),
    right = await b.launch();
  let pageA = await left.firstWindow(),
    pageB = await right.firstWindow();
  let ca = await a.connect(),
    cb = await b.connect();
  const responses = await guestResponseFixture();
  const hub = await spawnedHub(join(directory, "hub"));
  const metadata = {
    name: "shared-plan",
    title: proposal.title,
    kind: "plan",
    fileName: "plan.json",
    mediaType: "application/json",
    expectedRevision: 0,
  };
  let peerId = "";
  let pairingSecret = "";
  async function pair() {
    const paired = await pairGuests(
      left,
      right,
      pageA,
      pageB,
      ["Owner desktop", "Receiver desktop"],
      async (invitation) => {
        responses.target(invitation.endpoint.port);
        await writeFile(routes, JSON.stringify({ [invitation.endpoint.port]: responses.port }));
      },
    );
    peerId = paired.id;
    pairingSecret = paired.key;
    await expect
      .poll(
        () => pageB.evaluate(() => window.scope.guestCatalog()).then((v) => v.available.length),
        { timeout: 25000 },
      )
      .toBe(1);
  }
  async function select(page: typeof pageB, id: string) {
    const tab = page.locator(`#tab-${id}`);
    if (await tab.isVisible()) await tab.click();
    else {
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      const workspace = await page.evaluate(() => window.scope.workspace());
      const tab = workspace!.tabs.find((t) => t.id === id)!;
      await page
        .getByRole("button", {
          name: `${tab.title} ${tab.type === "guest" ? "guest" : "shared-plan · plan"}`,
          exact: true,
        })
        .click();
    }
  }
  const record = async () =>
    (await pageB.evaluate(() => window.scope.guestCatalog())).records.find(
      (r) => r.source.artifact?.id === "shared-id",
    )!;
  async function fresh() {
    const current = await ca.get("shared-id");
    await expect
      .poll(async () => (await record()).source.artifact?.revision)
      .toBe(current.revision);
    return current;
  }
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, [cliMain, ...args], {
          env: hub.env,
          timeout: 120000,
          maxBuffer: 100 * 1024 * 1024,
        })
      ).stdout,
    );
  const direct = async (...args: string[]) => JSON.parse((await b.cli(...args)).stdout);
  async function capture(name: string) {
    if (!process.env.SCOPE_REVIEW_DIR) return;
    await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
    await pageB.screenshot({
      path: join(process.env.SCOPE_REVIEW_DIR, `guest-plans-${name}.png`),
      animations: "disabled",
    });
  }
  try {
    await ca.publish("shared-id", metadata, Buffer.from(JSON.stringify(proposal)));
    await cb.publish(
      "shared-id",
      metadata,
      Buffer.from(
        JSON.stringify({ ...proposal, overviewHtml: "<h1>Receiver's different plan</h1>" }),
      ),
    );
    await pair();
    await pageB.evaluate((url) => window.scope.pairRemote(url), hub.pairUrl);
    await expect
      .poll(() => pageB.evaluate(() => window.scope.remotes()).then((r) => r[0]?.connection))
      .toBe("connected");
    const guest = await record();
    const target = { ownerDeviceId: guest.ownerDeviceId, sourceTabId: guest.source.sourceTabId };
    const flags = ["--owner-device", target.ownerDeviceId, "--source-tab", target.sourceTabId];
    const read = () => cli("plan", "read", "shared-id", ...flags);
    const readLocal = async () =>
      readPlan(await cb.content("shared-id", (await cb.get("shared-id")).revision));
    let current = await read();
    expect(current.owner).toMatchObject(target);
    expect(current.document).toEqual(proposal);
    expect((await readLocal()).overviewHtml).toContain("Receiver's different plan");
    expect((await direct("plan", "read", "shared-id", ...flags)).document).toEqual(proposal);
    await expect(cli("plan", "read", "shared-plan", ...flags)).rejects.toThrow(/No local plan/);
    await expect(
      cli("plan", "read", "shared-id", "--owner-device", target.ownerDeviceId),
    ).rejects.toThrow(/both/);
    const versions = () => [
      "--expected-revision",
      String(current.artifact.revision),
      "--expected-source-version",
      String(current.owner.sourceVersion),
    ];
    const exportPath = join(directory, "overview.html");
    await cli("plan", "content", "shared-id", ...flags, "--output", exportPath);
    expect(await readFile(exportPath, "utf8")).toBe(proposal.overviewHtml);
    await guestPlanDeadlines(
      decodeLocalConnection(JSON.parse(await readFile(b.connectionFile, "utf8"))),
      { endpoint: hub.endpoint, token: hub.token },
      target,
    );
    const preparation = await lostPreparation(hub.endpoint);
    try {
      await expect(
        exec(
          process.execPath,
          [
            cliMain,
            "plan",
            "capture-basis",
            "shared-id",
            "not-dispatched",
            ...flags,
            ...versions(),
          ],
          {
            env: { ...hub.env, SCOPE_ENDPOINT: preparation.endpoint, SCOPE_TOKEN: hub.token },
            timeout: 15000,
          },
        ),
      ).rejects.toThrow(/status/);
      const saved = await cb.guestPending(target);
      expect(saved!.dispatched).toBe(false);
      expect(saved!.outcome.state).toBe("prepared");
      expect((await cb.guestPending(target))!.operation).toEqual(saved!.operation);
      expect((await ca.get("shared-id")).revision).toBe(current.artifact.revision);
      const settled = await cli("plan", "status", "shared-id", ...flags);
      expect(settled.operation.operationId).toBe(saved!.operation.operationId);
      expect(settled.outcome.state).toBe("rejected");
      await cli("plan", "reconcile", "shared-id", ...flags);
    } finally {
      await preparation.close();
    }
    const captureResult = await cli(
      "plan",
      "capture-basis",
      "shared-id",
      "original",
      ...flags,
      ...versions(),
    );
    expect(captureResult.outcome.state).toBe("completed");
    expect((await cli("plan", "status", "shared-id", ...flags)).operation.operationId).toBe(
      captureResult.operationId,
    );
    await cli("plan", "reconcile", "shared-id", ...flags);
    await fresh();
    current = await read();
    const guestId = guest.tab.id;
    await select(pageB, guestId);
    let pane = pageB.locator(`#pane-${guestId}`);
    let frame = pane.locator("iframe").contentFrame();
    await frame.getByRole("button", { name: "Inspect request" }).click();
    await frame.getByRole("button", { name: "Inspected", exact: true }).waitFor();
    await pane.getByRole("button", { name: "Work items", exact: true }).click();
    await pane.getByRole("button", { name: "Preserve requests", exact: true }).click();
    await pane.getByRole("button", { name: "Copy work item", exact: true }).click();
    await pane.getByText("Work item copied.", { exact: true }).waitFor();
    const packet = JSON.parse(await right.evaluate(({ clipboard }) => clipboard.readText()));
    expect(packet.owner).toMatchObject(target);
    expect(JSON.stringify(packet)).not.toContain(pairingSecret);
    expect(JSON.stringify(packet)).not.toContain(hub.token);
    expect(await pane.locator("iframe").getAttribute("srcdoc")).not.toContain(pairingSecret);
    expect(await pane.locator("iframe").getAttribute("srcdoc")).not.toContain(hub.token);
    expect(packet.artifact.id).toBe("shared-id");
    expect(packet.prerequisites[0].item.id).toBe("prepare");
    expect(await cli(...packet.retrieval.item.split(" ").slice(1))).toEqual(packet);
    expect(await pane.locator(".plan-command").textContent()).toBe(packet.retrieval.item);
    await pane.locator("article").getByText("Keep the request", { exact: true }).click();
    await pane.locator("article").getByText(proposal.checks![0].method, { exact: true }).waitFor();
    for (const theme of ["light", "dark"] as const) {
      await pageB.keyboard.press("ControlOrMeta+,");
      const settings = pageB.getByRole("dialog", { name: "Settings", exact: true });
      await settings.getByLabel("Search settings").fill("appearance");
      await pageB.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await expect.poll(() => pageB.locator("html").getAttribute("data-theme")).toBe(theme);
      await settings.getByRole("button", { name: "Close", exact: true }).click();
      await settings.waitFor({ state: "hidden" });
      for (const width of [1366, 620]) {
        await right.evaluate(
          ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820),
          width,
        );
        await capture(`work-${theme}-${width}`);
        await pane
          .getByRole("button", { name: "Inspect proposal from revision 1", exact: true })
          .click();
        frame = pane.locator("iframe").contentFrame();
        await frame.getByRole("heading", { name: "Owner request plan" }).waitFor();
        await frame.locator('[data-plan-procedure="check"] summary').click();
        await capture(`basis-${theme}-${width}`);
        await pane.getByRole("button", { name: "Current proposal", exact: true }).click();
        await capture(`overview-${theme}-${width}`);
        await pane.getByRole("button", { name: "Work items", exact: true }).click();
      }
    }
    await right.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1366, 820),
    );
    // Owner and receiver keep different selections and positions.
    await select(pageA, guest.source.sourceTabId);
    const ownerPane = pageA.locator(`#pane-${guest.source.sourceTabId}`);
    await ownerPane.getByRole("button", { name: "Work items", exact: true }).click();
    await ownerPane
      .getByRole("button", { name: "Inspect proposal from revision 1", exact: true })
      .click();
    await ownerPane
      .locator("iframe")
      .contentFrame()
      .getByRole("heading", { name: "Owner request plan" })
      .waitFor();
    await ownerPane.getByRole("button", { name: "Current proposal", exact: true }).click();
    await expect
      .poll(async () => {
        await ownerPane
          .locator("iframe")
          .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollTo(0, 180));
        return (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
          (t) => t.id === guest.source.sourceTabId,
        )!.state.data.scrollY;
      })
      .toBe(180);
    await pane.getByRole("button", { name: "Overview", exact: true }).click();
    await pane
      .locator("iframe")
      .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollTo(0, 540));
    await expect
      .poll(async () => {
        await pane
          .locator("iframe")
          .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollTo(0, 540));
        const workspace = await pageB.evaluate(() => window.scope.workspace());
        return (
          workspace!.tabs.find((t) => t.id === guestId)!.state.data.plan as { scrollY: number }
        ).scrollY;
      })
      .toBe(540);
    await pane.getByRole("button", { name: "Work items", exact: true }).click();
    await pane.locator(".plan-work").evaluate((element) => {
      element.scrollTop = 240;
    });
    await pane
      .getByRole("button", { name: "Inspect proposal from revision 1", exact: true })
      .click();
    await pane
      .locator("iframe")
      .contentFrame()
      .getByRole("heading", { name: "Owner request plan" })
      .waitFor();
    await pane
      .locator("iframe")
      .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollTo(0, 320));
    await expect
      .poll(async () => {
        await pane
          .locator("iframe")
          .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollTo(0, 320));
        const workspace = await pageB.evaluate(() => window.scope.workspace());
        return (
          workspace!.tabs.find((t) => t.id === guestId)!.state.data.plan as { basisScrollY: number }
        ).basisScrollY;
      })
      .toBe(320);
    expect((await read()).document.agreements ?? []).toEqual([]);
    expect((await read()).document.evidence ?? []).toEqual([]);
    await pageB.evaluate((id) => window.scope.removeRemote(id), hub.id);
    await left.close();
    await right.close();
    left = await a.launch();
    right = await b.launch();
    pageA = await left.firstWindow();
    pageB = await right.firstWindow();
    ca = await a.connect();
    cb = await b.connect();
    await pair();
    await select(pageB, guestId);
    pane = pageB.locator(`#pane-${guestId}`);
    await pane.getByText("Recorded proposal, revision 1", { exact: true }).waitFor();
    await expect
      .poll(() =>
        pane
          .locator("iframe")
          .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollY),
      )
      .toBe(320);
    await pane.getByRole("button", { name: "Current proposal", exact: true }).click();
    await expect
      .poll(() =>
        pane
          .locator("iframe")
          .evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollY),
      )
      .toBe(540);
    await pane.getByRole("button", { name: "Work items", exact: true }).click();
    expect(
      await pane
        .getByRole("button", { name: "Preserve requests", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await expect
      .poll(() => pane.locator(".plan-work").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100);
    expect(
      (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
        (t) => t.id === guest.source.sourceTabId,
      )!.state.data.scrollY,
    ).toBe(180);
    // Linux credentials are session-only. Re-pair the synthetic hub explicitly after restart.
    await hub.stop();
    await hub.start();
    const newPair = /irudd-scope:\/\/pair\S+/.exec(await hub.cli("pair"))![0];
    await pageB.evaluate((url) => window.scope.pairRemote(url), newPair);
    await expect
      .poll(() => pageB.evaluate(() => window.scope.remotes()).then((r) => r[0]?.connection))
      .toBe("connected");
    current = await read();
    const json = join(directory, "replace.json"),
      html = join(directory, "replace.html");
    const next = {
      ...current.document,
      context: "Current revised context",
      agreements: [
        {
          id: "agreed",
          basisId: "original",
          targetIds: ["goal"],
          note: "Synthetic recorded agreement.",
        },
      ],
      evidence: [
        {
          id: "verified",
          basisId: "original",
          checkId: "check",
          expected: "One result",
          observed: "One result",
          implementation: "Synthetic build",
          conditions: "Synthetic desktops",
          result: "passed",
        },
      ],
    };
    await writeFile(json, JSON.stringify(next));
    await writeFile(html, next.overviewHtml);
    const oldVersions = versions();
    responses.dropNextMutationReply();
    await expect(
      cli("plan", "publish", "shared-id", json, html, ...flags, ...oldVersions),
    ).rejects.toThrow(/status/);
    const lost = await cli("plan", "status", "shared-id", ...flags);
    expect(lost.outcome.state).toBe("completed");
    expect(lost.operation.change.action.document).toEqual(next);
    expect((await cli("plan", "status", "shared-id", ...flags)).operation.operationId).toBe(
      lost.operation.operationId,
    );
    await cli("plan", "reconcile", "shared-id", ...flags);
    await fresh();
    current = await read();
    await expect
      .poll(() =>
        pane
          .getByRole("button", { name: "Preserve requests", exact: true })
          .getAttribute("aria-pressed"),
      )
      .toBe("true");
    await expect
      .poll(() => pane.locator(".plan-work").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100);
    await pane.getByText("Current revised context", { exact: true }).waitFor();
    await pane.getByText("Synthetic recorded agreement.", { exact: true }).waitFor();
    await pane.getByText("Keep the request: passed on recorded proposal", { exact: true }).click();
    await pane.getByText("Synthetic recorded agreement.", { exact: true }).scrollIntoViewIfNeeded();
    await capture("records-dark-laptop");
    await expect(
      cli("plan", "publish", "shared-id", json, html, ...flags, ...oldVersions),
    ).rejects.toThrow(/changed/);
    await writeFile(json, JSON.stringify({ ...next, bases: [] }));
    await expect(
      cli("plan", "publish", "shared-id", json, html, ...flags, ...versions()),
    ).rejects.toThrow(/basis|bases/i);
    await writeFile(json, JSON.stringify({ ...next, agreements: [] }));
    await expect(
      cli("plan", "publish", "shared-id", json, html, ...flags, ...versions()),
    ).rejects.toThrow(/Preserve recorded/);
    responses.dropNextMutationReply();
    await expect(
      cli("plan", "capture-basis", "shared-id", "second", ...flags, ...versions()),
    ).rejects.toThrow(/status/);
    const basisLost = await cli("plan", "status", "shared-id", ...flags);
    expect(basisLost.outcome.state).toBe("completed");
    await cli("plan", "reconcile", "shared-id", ...flags);
    await fresh();
    current = await read();
    expect(
      current.document.bases.filter((basis: { id: string }) => basis.id === "second"),
    ).toHaveLength(1);
    // Valid content just below 32 MiB, with quotes that exercise JSON-in-JSON response framing.
    const big = { ...current.document, overviewHtml: "" };
    big.overviewHtml = '"'.repeat(
      Math.floor((32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(big)) - 4096) / 2),
    );
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(31.9 * 1024 * 1024);
    await writeFile(json, JSON.stringify(big));
    await writeFile(html, big.overviewHtml);
    await cli("plan", "publish", "shared-id", json, html, ...flags, ...versions());
    await cli("plan", "reconcile", "shared-id", ...flags);
    await fresh();
    const largeRead = await read();
    expect(largeRead.document.overviewHtml).toBe(big.overviewHtml);
    await writeFile(json, JSON.stringify(next));
    await writeFile(html, next.overviewHtml);
    // Preserve both immutable bases when returning to the smaller document.
    const small = { ...largeRead.document, overviewHtml: proposal.overviewHtml };
    await writeFile(json, JSON.stringify(small));
    current = largeRead;
    await cli("plan", "publish", "shared-id", json, html, ...flags, ...versions());
    await cli("plan", "reconcile", "shared-id", ...flags);
    await fresh();
    expect((await cb.get("shared-id")).revision).toBe(1);
    expect((await readLocal()).overviewHtml).toContain("Receiver's different plan");
    const db = new DatabaseSync(join(b.settingsDirectory, "artifacts", "scope.db"), {
      readOnly: true,
    });
    try {
      expect(
        db.prepare("SELECT count(*) AS count FROM artifacts WHERE id = 'shared-id'").get()!.count,
      ).toBe(1);
    } finally {
      db.close();
    }
    // The owner enforces a race after preparation, independently of the CLI's early guard.
    const source = (await cb.guestSource(target))!;
    const prepared = await cb.guestPrepare({
      version: 1,
      target,
      expectedRevision: source.artifact!.revision,
      expectedSourceVersion: source.sourceVersion!,
      action: { kind: "capture-basis", basisId: "conflicting" },
    });
    const identity = { operationId: prepared.operationId, digest: prepared.digest };
    const beforeRace = await ca.get("shared-id");
    await ca.publish(
      "shared-id",
      { ...metadata, expectedRevision: beforeRace.revision },
      Buffer.from(JSON.stringify({ ...small, context: "Concurrent owner update" })),
    );
    expect((await cb.guestExecute(target, identity)).state).toBe("conflict");
    await fresh();
    await select(pageB, guestId);
    const actions = pane.getByText(/Source actions ·/);
    if ((await actions.locator("..").getAttribute("open")) === null) await actions.click();
    await pane
      .getByText(/conflict/i)
      .first()
      .waitFor();
    await capture("conflict-dark-laptop");
    await cli("plan", "reconcile", "shared-id", ...flags);
    if ((await actions.locator("..").getAttribute("open")) !== null) await actions.click();
    expect(
      (await read()).document.bases.some((basis: { id: string }) => basis.id === "conflicting"),
    ).toBe(false);
    for (const capability of ["plan-read-v1", "mutations-v1"]) {
      responses.omitCapabilities(pairingSecret, [capability]);
      await pageB.evaluate((id) => window.scope.setGuestAccess(id, false), peerId);
      await pageB.evaluate((id) => window.scope.setGuestAccess(id, true), peerId);
      await expect
        .poll(
          () => pageB.evaluate(() => window.scope.guestStatus()).then((s) => s.peers[0]?.state),
          { timeout: 25000 },
        )
        .toBe("connected");
      await expect
        .poll(
          () => pageB.evaluate(() => window.scope.guestCatalog()).then((v) => v.available.length),
          { timeout: 30000 },
        )
        .toBe(1);
      await expect(read()).rejects.toThrow(/Update/i);
      if (capability === "plan-read-v1") {
        await pageB.reload();
        await select(pageB, guestId);
        pane = pageB.locator(`#pane-${guestId}`);
        await pane.getByText(/Update the other Scope|Update Scope/).waitFor();
        await capture("update-dark-laptop");
      }
      responses.omitCapabilities(pairingSecret, []);
      await pageB.evaluate((id) => window.scope.setGuestAccess(id, false), peerId);
      await pageB.evaluate((id) => window.scope.setGuestAccess(id, true), peerId);
      await expect
        .poll(
          () => pageB.evaluate(() => window.scope.guestStatus()).then((s) => s.peers[0]?.state),
          { timeout: 25000 },
        )
        .toBe("connected");
      await expect
        .poll(
          () => pageB.evaluate(() => window.scope.guestCatalog()).then((v) => v.available.length),
          { timeout: 30000 },
        )
        .toBe(1);
      await expect
        .poll(
          async () => {
            try {
              return (await read()).artifact.id;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
          { timeout: 30000 },
        )
        .toBe("shared-id");
    }
    responses.offline(true);
    await expect(read()).rejects.toThrow();
    await expect
      .poll(
        () => pageB.evaluate(() => window.scope.guestCatalog()).then((v) => v.available.length),
        { timeout: 30000 },
      )
      .toBe(0);
    await capture("offline-dark-laptop");
    responses.offline(false);
    await expect
      .poll(
        () => pageB.evaluate(() => window.scope.guestCatalog()).then((v) => v.available.length),
        { timeout: 30000 },
      )
      .toBe(1);
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, false), peerId);
    await expect(read()).rejects.toThrow();
    await pageB.evaluate((id) => window.scope.forgetGuest(id), peerId);
    await expect(read()).rejects.toThrow(/paired|unavailable/i);
    expect((await cb.get("shared-id")).revision).toBe(1);
  } finally {
    await hub.stop();
    await responses.close();
    await Promise.allSettled([left.close(), right.close()]);
    await Promise.all(
      [directory, a.directory, b.directory].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
}
