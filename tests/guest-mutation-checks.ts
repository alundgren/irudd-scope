import { guestNetworkFixture } from "./guest-network-fixture.ts";
import { expect } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  GuestAction,
  GuestChange,
  GuestOperation,
} from "@irudd-scope/protocol/guest-operation";
import { desktopFixture } from "./desktop-fixture.ts";
import { syntheticCli } from "./synthetic-cli.ts";
import {
  guestRecoveryChecks,
  guestReadFailureChecks,
  guestTitleCleanupChecks,
} from "./guest-recovery-checks.ts";
import { guestCli } from "./guest-cli.ts";
import { guestResponseFixture } from "./guest-response-fixture.ts";

export async function guestMutationChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-mutations-"));
  const routes = join(directory, "routes.json");
  await writeFile(routes, "{}");
  await syntheticCli(directory, "tailcat", guestCli);
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
  let ca = await a.connect();
  const responses = await guestResponseFixture();
  const html =
    '<h1>Guest mutation example</h1><label>Notes<textarea id="notes"></textarea></label><label>Choice<select id="choice"><option>a</option><option>b</option></select></label><input id="agreed" type="checkbox"><input id="first" type="radio" name="radio-choice"><input id="second" type="radio" name="radio-choice"><input id="password" type="password"><input name="ambiguous"><input name="ambiguous"><script>document.body.dataset.events="0"; document.addEventListener("input",()=>document.body.dataset.events=String(Number(document.body.dataset.events)+1));</script>';
  let artifact = await ca.publish(
    "mutation-document",
    {
      name: "mutation-document",
      title: "Mutation source",
      kind: "html",
      mediaType: "text/html",
      fileName: "mutation.html",
      expectedRevision: 0,
    },
    Buffer.from(html),
  );
  const plan = { version: 1 as const, title: "Mutation plan", overviewHtml: "<h1>Proposal</h1>" };
  await ca.publish(
    "mutation-plan",
    {
      name: "mutation-plan",
      title: plan.title,
      kind: "plan",
      mediaType: "application/json",
      fileName: "mutation-plan.json",
      expectedRevision: 0,
    },
    Buffer.from(JSON.stringify(plan)),
  );
  let peerId = "";
  async function pair(expected = 2) {
    for (const peer of (await pageA.evaluate(() => window.scope.transferDevices())).peers)
      await pageA.evaluate((id) => window.scope.forgetScope(id), peer.id);
    for (const peer of (await pageB.evaluate(() => window.scope.transferDevices())).peers)
      await pageB.evaluate((id) => window.scope.forgetScope(id), peer.id);
    const invitation = await pageA.evaluate(() => window.scope.createPairing("Owner laptop"));
    await pageA.evaluate((id) => window.scope.copyPairingSecret(id), invitation.id);
    const secret = await left.evaluate(({ clipboard }) => clipboard.readText());
    await pageB.evaluate((input) => window.scope.pairScope(input), {
      url: invitation.url,
      secret,
      name: "Guest laptop",
    });
    peerId = (await pageA.evaluate(() => window.scope.transferDevices())).peers.at(-1)!.id;
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, true), peerId);
    await pageB.evaluate((id) => window.scope.setGuestAccess(id, true), peerId);
    await pageA.evaluate((id) => window.scope.copyGuestLink(id), peerId);
    const link = await left.evaluate(({ clipboard }) => clipboard.readText());
    const endpoint = JSON.parse(Buffer.from(link.split("#")[1], "base64url").toString()).endpoint;
    responses.target(endpoint.port);
    await writeFile(routes, JSON.stringify({ [endpoint.port]: responses.port }));
    await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), link);
    await pageB.evaluate((id) => window.scope.connectGuestLink(id), peerId);
    await expect
      .poll(
        () =>
          pageB.evaluate(() => window.scope.guestCatalog()).then((view) => view.available.length),
        { timeout: 25000 },
      )
      .toBe(expected);
  }
  const record = async (id = "mutation-document") =>
    (await pageB.evaluate(() => window.scope.guestCatalog())).records.find(
      (record) => record.source.artifact?.id === id,
    )!;
  async function change(action: GuestAction, id = "mutation-document"): Promise<GuestChange> {
    const current = await record(id);
    return {
      version: 1,
      target: { ownerDeviceId: current.ownerDeviceId, sourceTabId: current.source.sourceTabId },
      expectedSourceVersion: current.source.sourceVersion!,
      expectedRevision: current.source.artifact!.revision,
      action,
    };
  }
  async function fresh(id = "mutation-document") {
    const latest = await ca.get(id);
    await expect
      .poll(async () => (await record(id)).source.artifact?.revision)
      .toBe(latest.revision);
    return latest;
  }
  async function select(id: string) {
    const tab = pageB.locator(`#tab-${id}`);
    if (await tab.isVisible()) await tab.click();
    else {
      await pageB.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await pageB.getByLabel("Search tabs", { exact: true }).fill((await record()).tab.title);
      await pageB
        .getByRole("button", { name: (await record()).tab.title + " guest", exact: true })
        .click();
    }
  }
  async function capture(name: string) {
    if (!process.env.SCOPE_REVIEW_DIR) return;
    await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
    await pageB.screenshot({
      path: join(process.env.SCOPE_REVIEW_DIR, name),
      animations: "disabled",
    });
  }
  const ownerDb = (work: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(join(a.settingsDirectory, "artifacts", "scope.db"));
    try {
      work(db);
    } finally {
      db.close();
    }
  };
  try {
    await pair();
    const guestId = (await record()).tab.id;
    const sourceId = (await record()).source.sourceTabId;
    const target = (await change({ kind: "trash" })).target;
    await select(guestId);
    let pane = pageB.locator(`#pane-${guestId}`);
    let frame = pane.locator("iframe").contentFrame();
    const openActions = async () => {
      const summary = pane.getByText(/Source actions ·/);
      if ((await summary.locator("..").getAttribute("open")) === null) await summary.click();
    };
    const openRecovery = async () => {
      const summary = pane.locator("summary").filter({ hasText: "Form input recovery" });
      if ((await summary.locator("..").getAttribute("open")) === null) await summary.click();
    };
    await frame.getByRole("heading", { name: "Guest mutation example" }).waitFor();
    const recoveryDb = new DatabaseSync(join(b.settingsDirectory, "desktop.db"));
    recoveryDb.exec(
      "CREATE TRIGGER reject_recovery BEFORE INSERT ON guest_recovery BEGIN SELECT RAISE(ABORT, 'Synthetic recovery failure'); END",
    );
    await frame.locator("#notes").fill("Recover this note after restart");
    await pane.getByText("Could not save form input. Keep Scope open and retry.").waitFor();
    await pageB.getByRole("button", { name: "Close Mutation source", exact: true }).click();
    await pageB.getByText("Could not save this tab. Try again.", { exact: true }).waitFor();
    expect(await frame.locator("#notes").inputValue()).toBe("Recover this note after restart");
    recoveryDb.exec("DROP TRIGGER reject_recovery");
    recoveryDb.close();
    await pane.getByRole("button", { name: "Retry form save" }).click();
    await pageB.getByRole("button", { name: "Dismiss error", exact: true }).click();
    await frame.locator("#choice").selectOption("b");
    await frame.locator("#agreed").check();
    await frame.locator("#first").check();
    await frame.locator("#second").check();
    await frame.locator("#first").check();
    await frame.locator("#password").fill("not-persisted-password");
    await frame.locator('[name="ambiguous"]').first().fill("not-persisted-ambiguous");
    await expect
      .poll(() =>
        pageB
          .evaluate((id) => window.scope.guestRecovery(id), guestId)
          .then((value) => value.inputs.find((input) => input.kind === "html")?.fields.length),
      )
      .toBe(5);
    const saved = await pageB.evaluate((id) => window.scope.guestRecovery(id), guestId);
    expect(JSON.stringify(saved)).not.toContain("not-persisted");
    expect(JSON.stringify(saved)).not.toContain("<h1>");
    await expect(
      pageB.evaluate((input) => window.scope.saveGuestInput(input), {
        ...saved.inputs[0],
        fields: [
          {
            key: "id:password",
            tag: "input" as const,
            type: "password",
            value: "must-not-persist",
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      pageB.evaluate((input) => window.scope.saveGuestInput(input), {
        ...saved.inputs[0],
        ownerDeviceId: randomUUID(),
      }),
    ).rejects.toThrow("different guest");
    await guestReadFailureChecks({ page: pageB, app: right, guestId, capture });
    await right.close();
    right = await b.launch();
    pageB = await right.firstWindow();
    await pair();
    await select(guestId);
    pane = pageB.locator(`#pane-${guestId}`);
    frame = pane.locator("iframe").contentFrame();
    await frame.locator("#notes").waitFor();
    expect(await frame.locator("#notes").inputValue()).toBe("");
    await openRecovery();
    await pane.getByRole("button", { name: "Restore saved fields" }).click();
    expect(await frame.locator("#notes").inputValue()).toBe(
      "Recovered after an initial read failure",
    );
    expect(await frame.locator("#choice").inputValue()).toBe("b");
    expect(await frame.locator("#agreed").isChecked()).toBe(true);
    expect(await frame.locator("#first").isChecked()).toBe(true);
    expect(await frame.locator("#second").isChecked()).toBe(false);
    expect(await frame.locator("body").getAttribute("data-events")).toBe("0");
    await capture("mutations-restored-light-laptop.png");
    artifact = await guestRecoveryChecks({
      page: pageB,
      app: right,
      client: ca,
      guestId,
      settingsDirectory: b.settingsDirectory,
      html,
      capture,
    });
    for (const mode of ["discard", "rename"] as const) {
      artifact = await guestTitleCleanupChecks({
        page: pageB,
        app: right,
        client: ca,
        guestId,
        html,
        mode,
      });
      await right.close();
      right = await b.launch();
      pageB = await right.firstWindow();
      await pair();
      await select(guestId);
      pane = pageB.locator(`#pane-${guestId}`);
      await openActions();
      expect(await pane.getByLabel("Source title", { exact: true }).inputValue()).toBe(
        artifact.title,
      );
      expect(
        (await pageB.evaluate((id) => window.scope.guestRecovery(id), guestId)).inputs.filter(
          (input) => input.kind === "action",
        ),
      ).toEqual([]);
    }
    await openActions();
    await pane.getByLabel("Source title", { exact: true }).fill("Retained competing title");
    artifact = await ca.publish(
      artifact.id,
      {
        name: artifact.name,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        fileName: artifact.fileName,
        expectedRevision: artifact.revision,
        title: "Owner competing change",
      },
      Buffer.from(html),
    );
    await fresh();
    // Changed content revision never receives old form input, even with identical bytes.
    await openRecovery();
    await pane
      .getByText(/current revision .*copy or discard old input/)
      .first()
      .waitFor();
    expect(await pane.getByRole("button", { name: "Restore saved fields" }).count()).toBe(0);
    await openActions();
    await expect
      .poll(() => pane.getByLabel("Source title", { exact: true }).inputValue())
      .toBe("Retained competing title");
    await pane.getByRole("button", { name: "Rename on Owner laptop", exact: true }).click();
    await pane.getByText(/The owner changed this source/).waitFor();
    expect((await ca.get(artifact.id)).title).toBe("Owner competing change");
    expect(await pane.getByLabel("Source title", { exact: true }).inputValue()).toBe(
      "Retained competing title",
    );
    await right.close();
    right = await b.launch();
    pageB = await right.firstWindow();
    await pair();
    await select(guestId);
    pane = pageB.locator(`#pane-${guestId}`);
    await openActions();
    expect(await pane.getByLabel("Source title", { exact: true }).inputValue()).toBe(
      "Retained competing title",
    );
    expect(
      (await pageB.evaluate((id) => window.scope.guestRecovery(id), guestId)).pending?.outcome
        .state,
    ).toBe("conflict");
    await capture("mutations-conflict-light-laptop.png");
    await right.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
    await capture("mutations-conflict-light-narrow.png");
    await pageB.getByRole("button", { name: "Search and controls" }).click();
    await pageB.getByRole("button", { name: "Settings", exact: true }).click();
    await pageB.getByLabel("Search settings").fill("appearance");
    await pageB.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await pageB
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect.poll(() => pageB.locator("html").getAttribute("data-theme")).toBe("dark");
    await right.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
    await capture("mutations-conflict-dark-narrow.png");
    await right.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 820),
    );
    await capture("mutations-conflict-dark-laptop.png");
    await right.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
    await pane.getByRole("button", { name: "Review current owner source" }).click();
    await pane.getByRole("button", { name: "Rename on Owner laptop", exact: true }).click();
    await expect
      .poll(() => ca.get(artifact.id).then((value) => value.title))
      .toBe("Retained competing title");
    await fresh();
    await openActions();
    await pane
      .getByLabel("Source title", { exact: true })
      .fill("Unsubmitted title retained through retention and trash");
    await pane
      .getByRole("button", { name: "Keep permanently on Owner laptop", exact: true })
      .click();
    await expect
      .poll(() =>
        pageA
          .evaluate(() => window.scope.retainedTabs())
          .then((tabs) => tabs.find((entry) => entry.tab.id === sourceId)?.permanent),
      )
      .toBe(true);
    await expect.poll(async () => (await record()).source.permanent).toBe(true);
    await expect
      .poll(() => pane.getByLabel("Source title", { exact: true }).inputValue())
      .toBe("Unsubmitted title retained through retention and trash");
    expect(
      (await pageB.evaluate((id) => window.scope.guestRecovery(id), guestId)).inputs.find(
        (input) => input.kind === "action",
      )?.title,
    ).toBe("Unsubmitted title retained through retention and trash");
    await right.close();
    right = await b.launch();
    pageB = await right.firstWindow();
    await pair();
    await select(guestId);
    pane = pageB.locator(`#pane-${guestId}`);
    await openActions();
    expect(await pane.getByLabel("Source title", { exact: true }).inputValue()).toBe(
      "Unsubmitted title retained through retention and trash",
    );
    await pane.getByRole("button", { name: "Review current owner source", exact: true }).click();
    await pane
      .getByRole("button", { name: "Move source to Trashcan on Owner laptop", exact: true })
      .click();
    await pane.getByText(/This source is no longer shared by Owner laptop/).waitFor();
    await expect
      .poll(() => pane.getByLabel("Source title", { exact: true }).inputValue())
      .toBe("Unsubmitted title retained through retention and trash");
    await expect
      .poll(
        async () => (await pageB.evaluate((id) => window.scope.guestRecovery(id), guestId)).pending,
      )
      .toBeUndefined();
    await right.close();
    right = await b.launch();
    pageB = await right.firstWindow();
    await pair(1);
    await select(guestId);
    pane = pageB.locator(`#pane-${guestId}`);
    await openActions();
    expect(await pane.getByLabel("Source title", { exact: true }).inputValue()).toBe(
      "Unsubmitted title retained through retention and trash",
    );
    await pageA.evaluate((id) => window.scope.restoreTab(id), sourceId);
    await expect
      .poll(async () => (await pageB.evaluate(() => window.scope.guestCatalog())).available.length)
      .toBe(2);
    await pane.getByRole("button", { name: "Discard title draft", exact: true }).click();
    await expect
      .poll(() => pane.getByLabel("Source title", { exact: true }).inputValue())
      .toBe("Retained competing title");
    const beforeClose = (await record()).source.sourceVersion;
    await pageB
      .getByRole("button", { name: "Close Retained competing title", exact: true })
      .click();
    expect((await ca.get(artifact.id)).title).toBe("Retained competing title");
    expect((await record()).source.sourceVersion).toBe(beforeClose);
    await select(guestId);
    // A failed receipt write must roll back the source mutation as well.
    const operation = await pageB.evaluate(
      (change) => window.scope.guestPrepare(change),
      await change({ kind: "rename", title: "Must roll back" }),
    );
    ownerDb((db) =>
      db.exec(
        "CREATE TRIGGER reject_guest_receipt BEFORE UPDATE ON guest_operations WHEN json_extract(NEW.outcome, '$.state') = 'completed' BEGIN SELECT RAISE(ABORT, 'Synthetic receipt failure'); END",
      ),
    );
    await expect(
      pageB.evaluate(({ target, operation }) => window.scope.guestExecute(target, operation), {
        target,
        operation,
      }),
    ).rejects.toThrow("uncertain");
    expect((await ca.get(artifact.id)).title).toBe("Retained competing title");
    ownerDb((db) => db.exec("DROP TRIGGER reject_guest_receipt"));
    expect(
      (
        await pageB.evaluate(
          ({ target, operation }) => window.scope.guestOperationStatus(target, operation),
          { target, operation },
        )
      ).state,
    ).toBe("rejected");
    await pageB.evaluate(
      ({ target, operation }) => window.scope.guestReconcile(target, operation),
      { target, operation },
    );
    const prepareRaw = async (input: GuestChange): Promise<GuestOperation> => {
      const reply = await responses.peer("mutation-prepare", input);
      expect(reply.status).toBe(200);
      return { operationId: reply.body.operationId, digest: reply.body.digest, change: input };
    };
    const cancelled = await prepareRaw(await change({ kind: "rename", title: "Cancelled write" }));
    expect(
      (
        await responses.peer("mutation-status", {
          operationId: cancelled.operationId,
          digest: cancelled.digest,
        })
      ).body.state,
    ).toBe("rejected");
    expect((await responses.peer("mutation-execute", cancelled)).body.state).toBe("rejected");
    expect((await ca.get(artifact.id)).title).toBe("Retained competing title");
    const mismatched = await prepareRaw(await change({ kind: "rename", title: "Bound body" }));
    expect(
      (
        await responses.peer("mutation-execute", {
          ...mismatched,
          change: { ...mismatched.change, action: { kind: "rename", title: "Forged body" } },
        })
      ).status,
    ).not.toBe(200);
    ownerDb((db) =>
      db
        .prepare("UPDATE guest_operations SET caller = ? WHERE id = ?")
        .run(randomUUID(), mismatched.operationId),
    );
    expect((await responses.peer("mutation-execute", mismatched)).status).not.toBe(200);
    expect(
      (await responses.peer("mutation-execute", { ...cancelled, operationId: randomUUID() })).body
        .state,
    ).toBe("unknown");
    const navigation = await prepareRaw(
      await change({ kind: "rename", title: "After owner navigation" }),
    );
    await pageA.evaluate(async (id) => {
      await window.scope.setTabHidden(id, true);
      await window.scope.setTabHidden(id, false);
      await window.scope.reportVisibleTabs([id]);
    }, sourceId);
    expect((await responses.peer("mutation-execute", navigation)).body.state).toBe("completed");
    await fresh();
    const first = await prepareRaw(await change({ kind: "rename", title: "Concurrent one" }));
    const second = await prepareRaw(await change({ kind: "rename", title: "Concurrent two" }));
    const outcomes = await Promise.all(
      [first, second].map((operation) => responses.peer("mutation-execute", operation)),
    );
    expect(outcomes.map((reply) => reply.body.state).sort()).toEqual(["completed", "conflict"]);
    await fresh();
    const rejectedAction = await responses.peer("mutation-prepare", {
      ...(await change({ kind: "trash" })),
      action: { kind: "callback", path: "/private/forged", channel: "scope:publish" },
    });
    expect(rejectedAction.status).not.toBe(200);
    const builtin = (await pageA.evaluate(() => window.scope.workspace()))!.tabs.find(
      (tab) => tab.type === "prompts",
    )!;
    expect(
      (
        await responses.peer("mutation-prepare", {
          ...(await change({ kind: "trash" })),
          target: { ...target, sourceTabId: builtin.id },
        })
      ).status,
    ).not.toBe(200);
    const lateTrash = await prepareRaw(
      await change({ kind: "rename", title: "Too late after trash" }),
    );
    await pageA.evaluate((id) => window.scope.closeTab(id), sourceId);
    expect((await responses.peer("mutation-execute", lateTrash)).body.state).toBe("rejected");
    await pageA.evaluate((id) => window.scope.restoreTab(id), sourceId);
    await expect
      .poll(async () => (await record()).source.sourceVersion)
      .toBeGreaterThan(lateTrash.change.expectedSourceVersion);
    // Existing plan validation and retained basis capture execute at the owner.
    const captureBasis = await prepareRaw(
      await change({ kind: "capture-basis", basisId: "proposal" }, "mutation-plan"),
    );
    expect((await responses.peer("mutation-execute", captureBasis)).body.state).toBe("completed");
    const planArtifact = await fresh("mutation-plan");
    const captured = JSON.parse(
      Buffer.from(await ca.content(planArtifact.id, planArtifact.revision)).toString(),
    );
    expect(captured.bases[0]).toMatchObject({
      id: "proposal",
      revision: captureBasis.change.expectedRevision,
    });
    const invalidPlan = await prepareRaw(
      await change({ kind: "replace-plan", document: plan }, "mutation-plan"),
    );
    expect((await responses.peer("mutation-execute", invalidPlan)).body.state).toBe("rejected");
    expect((await ca.get("mutation-plan")).revision).toBe(planArtifact.revision);
    const replace = await prepareRaw(
      await change(
        {
          kind: "replace-plan",
          document: { ...captured, context: "Changed proposal with retained basis" },
        },
        "mutation-plan",
      ),
    );
    expect((await responses.peer("mutation-execute", replace)).body.state).toBe("completed");
    await fresh("mutation-plan");
    const connection = JSON.parse(await readFile(b.connectionFile, "utf8"));
    const local = async (route: string, input: unknown) => {
      const response = await fetch(`${connection.endpoint}/v1/guests/${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const largeChange = await change(
      {
        kind: "replace-plan",
        document: {
          ...captured,
          overviewHtml: "<h1>Near-limit proposal</h1><!--" + "x".repeat(32_000_000) + "-->",
        },
      },
      "mutation-plan",
    );
    const authoritative = await local("source", largeChange.target);
    expect(authoritative.sourceVersion).toBe(largeChange.expectedSourceVersion);
    expect(authoritative.artifact.revision).toBe(largeChange.expectedRevision);
    const large = await local("prepare", largeChange);
    const largeIdentity = {
      target: largeChange.target,
      operationId: large.operationId,
      digest: large.digest,
    };
    expect((await local("execute", largeIdentity)).state).toBe("completed");
    await local("reconcile", largeIdentity);
    const largeArtifact = await fresh("mutation-plan");
    const read = await local("read", {
      target: largeChange.target,
      revision: largeArtifact.revision,
    });
    expect(JSON.parse(read.content).overviewHtml.length).toBeGreaterThan(30 * 1024 * 1024);
    // An interrupted reply retains the exact dispatch identity across both app restarts.
    const lost = await pageB.evaluate(
      (change) => window.scope.guestPrepare(change),
      await change({ kind: "trash" }),
    );
    responses.dropNextMutationReply();
    await expect(
      pageB.evaluate(({ target, lost }) => window.scope.guestExecute(target, lost), {
        target,
        lost,
      }),
    ).rejects.toThrow("uncertain");
    await expect
      .poll(
        () =>
          pageA
            .evaluate(() => window.scope.retainedTabs())
            .then((tabs) => tabs.find((entry) => entry.tab.id === sourceId)?.trashedAt !== null),
        { timeout: 15000 },
      )
      .toBe(true);
    await openActions();
    expect(await pane.getByRole("button", { name: "Check operation status" }).isEnabled()).toBe(
      true,
    );
    expect(await pane.getByText("Saved on Owner laptop.", { exact: true }).count()).toBe(0);
    await capture("mutations-lost-trash-reply-dark-narrow.png");
    await left.close();
    left = await a.launch();
    pageA = await left.firstWindow();
    ca = await a.connect();
    await right.close();
    right = await b.launch();
    pageB = await right.firstWindow();
    // One shared plan remains. Pairing helper expects two, so restore only after receipt status below.
    await pageA.evaluate((id) => window.scope.restoreTab(id), sourceId);
    await pair();
    await pageA.evaluate((id) => window.scope.closeTab(id), sourceId);
    const recovered = await pageB.evaluate((id) => window.scope.guestRecovery(id), guestId);
    expect(recovered.pending?.operation.operationId).toBe(lost.operationId);
    expect(recovered.pending?.dispatched).toBe(true);
    expect(
      (
        await pageB.evaluate(
          ({ target, lost }) => window.scope.guestOperationStatus(target, lost),
          { target, lost },
        )
      ).state,
    ).toBe("completed");
    await expect(
      pageB.evaluate(({ target, lost }) => window.scope.guestExecute(target, lost), {
        target,
        lost,
      }),
    ).rejects.toThrow("dispatched");
    await pageB.evaluate(({ target, lost }) => window.scope.guestReconcile(target, lost), {
      target,
      lost,
    });
    // Consent is checked at execution, even for an already prepared ID.
    await pageA.evaluate((id) => window.scope.restoreTab(id), sourceId);
    await expect
      .poll(async () => (await record()).source.sourceVersion)
      .toBeGreaterThan(lost.change.expectedSourceVersion);
    const revoked = await prepareRaw(
      await change({ kind: "rename", title: "Late revoked change" }),
    );
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, false), peerId);
    const rejected = await responses.peer("mutation-execute", revoked).then(
      (response) => response.status,
      (error: Error & { cause?: NodeJS.ErrnoException }) => {
        expect(error.cause?.code).toBe("ECONNREFUSED");
        return 0;
      },
    );
    expect(rejected).not.toBe(200);
    expect((await ca.get(artifact.id)).title).not.toBe("Late revoked change");
    await select(guestId);
    await right.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
    await capture("mutations-offline-recovery-dark-narrow.png");
    await pageA.evaluate((id) => window.scope.setGuestAccess(id, true), peerId);
    await pageB.evaluate((id) => window.scope.retryGuest(id), peerId);
    await expect
      .poll(
        () =>
          pageB.evaluate(() => window.scope.guestCatalog()).then((view) => view.available.length),
        { timeout: 25000 },
      )
      .toBe(2);
    const aged = await prepareRaw(await change({ kind: "rename", title: "Expired write" }));
    ownerDb((db) =>
      db
        .prepare("UPDATE lifecycle SET value = ? WHERE name = 'guest_clock'")
        .run(Date.now() + 49 * 60 * 60_000),
    );
    expect(
      (
        await responses.peer("mutation-status", {
          operationId: aged.operationId,
          digest: aged.digest,
        })
      ).body.state,
    ).toBe("expired");
    expect((await responses.peer("mutation-execute", aged)).body.state).toBe("expired");
    const liveReceipt = await prepareRaw(
      await change({ kind: "rename", title: "New after clock advance" }),
    );
    expect((await responses.peer("mutation-execute", aged)).body.state).toBe("unknown");
    expect((await ca.get(artifact.id)).title).not.toBe("Expired write");
    ownerDb((db) => {
      const row = db
        .prepare("SELECT * FROM guest_operations WHERE id = ?")
        .get(liveReceipt.operationId) as {
        caller: string;
        digest: string;
        expires_at: number;
        outcome: string;
      };
      const count = (
        db.prepare("SELECT count(*) AS count FROM guest_operations").get() as { count: number }
      ).count;
      const insert = db.prepare("INSERT INTO guest_operations VALUES (?, ?, ?, ?, ?)");
      db.exec("BEGIN");
      for (let i = count; i < 4096; i++) {
        const id = randomUUID();
        insert.run(
          id,
          row.caller,
          row.digest,
          row.expires_at,
          JSON.stringify({ ...JSON.parse(row.outcome), operationId: id }),
        );
      }
      db.exec("COMMIT");
    });
    expect(
      (await responses.peer("mutation-prepare", await change({ kind: "trash" }))).status,
    ).not.toBe(200);
    expect(
      (
        await responses.peer("mutation-status", {
          operationId: liveReceipt.operationId,
          digest: liveReceipt.digest,
        })
      ).body.state,
    ).toBe("rejected");
    // Receiver drafts are ordinary recovery records, never owner artifacts or persistent HTML.
    const db = new DatabaseSync(join(b.settingsDirectory, "artifacts", "scope.db"));
    try {
      expect(db.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  } finally {
    const cleanup = await Promise.allSettled([left.close(), right.close()]);
    await responses.close();
    await Promise.all(
      [a.directory, b.directory, directory].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Guest test cleanup failed.",
      );
  }
}
