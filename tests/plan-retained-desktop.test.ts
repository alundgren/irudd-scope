import { expect, test } from "vite-plus/test";
import type { Page } from "@playwright/test";
import type { PlanDocument } from "@irudd-scope/protocol/plan";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

const original: PlanDocument = {
  version: 1,
  title: "Request processing",
  overviewHtml:
    '<!doctype html><h1 id="request">Original request flow</h1><p>Request enters the worker.</p>',
  context: "Original proposal context.",
  constraints: ["Original proposal constraint."],
  questions: ["Original unresolved question?"],
  goals: [{ id: "latencyGoal", outcome: "Original bounded request latency." }],
  visuals: [
    {
      id: "requestVisual",
      anchor: "request",
      commitment: "Original request flow commitment.",
      goalIds: ["latencyGoal"],
      checkIds: ["readability"],
    },
  ],
  checks: [
    {
      id: "latencyCheck",
      label: "Request latency",
      goalIds: ["latencyGoal"],
      expectation: "Completes within five seconds.",
      conditions: "Use 500 synthetic requests.",
      method: "Time every request on fixture A.",
      kind: "agent",
      placement: "work",
    },
    {
      id: "readability",
      label: "Readable status",
      goalIds: ["latencyGoal"],
      expectation: "Status remains readable.",
      conditions: "Use a narrow window.",
      method: "Inspect the status at each step.",
      kind: "human",
    },
  ],
  items: [
    {
      id: "prepare",
      title: "Prepare requests",
      outcome: "Original fixture is ready.",
      goalIds: ["latencyGoal"],
      checkIds: [],
      dependsOn: [],
    },
    {
      id: "latencyItem",
      title: "Implement latency",
      outcome: "Original bounded latency implementation.",
      context: "Original item context.",
      constraints: ["Original item constraint."],
      goalIds: ["latencyGoal"],
      checkIds: ["latencyCheck", "readability"],
      dependsOn: ["prepare"],
    },
  ],
};

async function retainedDetails(page: Page) {
  const records = page.locator(".plan-records > section").filter({
    has: page.getByRole("button", { name: "Inspect proposal from revision 1", exact: true }),
  });
  const targets = records.getByRole("list", { name: "Agreement targets" }).locator(":scope > li");
  const check = targets.nth(0);
  await check.locator("summary").click();
  for (const text of [
    "Completes within five seconds.",
    "Use 500 synthetic requests.",
    "Time every request on fixture A.",
    "Agent check",
    "Original bounded request latency.",
    "Placement: Work items",
  ])
    await check.getByText(text, { exact: true }).waitFor();
  await targets.nth(1).getByText("Original bounded request latency.", { exact: true }).waitFor();
  const item = targets.nth(2);
  await item.locator(":scope > details > summary").click();
  for (const text of [
    "Original bounded latency implementation.",
    "Original item context.",
    "Original item constraint.",
    "Prepare requests: Original fixture is ready.",
  ])
    await item.getByText(text, { exact: true }).waitFor();
  const visual = targets.nth(3);
  await visual.locator(":scope > details > summary").click();
  await visual.getByText("Overview anchor: request", { exact: true }).waitFor();
  await visual.getByText("Readable status", { exact: true }).click();
  for (const text of [
    "Status remains readable.",
    "Use a narrow window.",
    "Inspect the status at each step.",
    "Requires human judgment",
  ])
    await visual.getByText(text, { exact: true }).waitFor();
  await records.getByText("Recorded proposal context", { exact: true }).click();
  for (const text of [
    "Original proposal context.",
    "Original proposal constraint.",
    "Original unresolved question?",
  ])
    await records.getByText(text, { exact: true }).waitFor();
}

async function inspectWithoutRecords(
  page: Page,
  revision: number,
  proposal: PlanDocument,
  heading: string,
) {
  const inspect = page.getByRole("button", {
    name: `Inspect proposal from revision ${revision}`,
    exact: true,
  });
  const retained = page.locator(".plan-records > section").filter({ has: inspect });
  await retained.getByText("No agreement or evidence recorded.", { exact: true }).waitFor();
  const checks = retained.locator("details").filter({
    has: page.locator("summary", { hasText: /^Proposal checks$/ }),
  });
  await checks.locator(":scope > summary").click();
  for (const check of proposal.checks ?? []) {
    const procedure = checks.locator(":scope > details").filter({
      has: page.getByText(check.label, { exact: true }),
    });
    await procedure.locator("summary").click();
    for (const text of [check.expectation, check.conditions, check.method])
      await procedure.getByText(text, { exact: true }).waitFor();
  }
  await inspect.click();
  await page
    .frameLocator(`iframe[title="Recorded proposal from revision ${revision}"]`)
    .getByRole("heading", { name: heading, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Current proposal", exact: true }).click();
  await page.frameLocator(`iframe[title="${proposal.title}"]`).locator("body").waitFor();
}

test(
  "every captured proposal remains inspectable without changing records or current work",
  { tags: ["publish", "survives-restart"], timeout: 120_000 },
  async () => {
    const { directory, launch, cli } = await desktopFixture({ hideInitialPrompts: true });
    let application = await launch();
    try {
      let page = await application.firstWindow();
      const json = join(directory, "plan.json"),
        html = join(directory, "overview.html");
      await writeFile(json, JSON.stringify(original));
      await writeFile(html, original.overviewHtml);
      await cli("plan", "publish", "latency-plan", json, html);
      await page.getByRole("tab", { name: original.title, exact: true }).click();
      await cli("plan", "capture-basis", "latency-plan", "discussed", "--expected-revision", "1");
      const read = JSON.parse((await cli("plan", "read", "latency-plan")).stdout);
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await inspectWithoutRecords(page, 1, original, "Original request flow");
      expect(JSON.parse((await cli("plan", "read", "latency-plan")).stdout)).toEqual(read);
      const changed: PlanDocument = {
        ...read.document,
        context: "Current proposal context.",
        constraints: ["Current proposal constraint."],
        questions: ["Current unresolved question?"],
        goals: [{ id: "latencyGoal", outcome: "Current latency goal." }],
        visuals: original.visuals!.map((visual) => ({
          ...visual,
          commitment: "Current flow commitment.",
        })),
        checks: original.checks!.map((check) => ({
          ...check,
          expectation: "Completes within two seconds.",
          conditions: "Use 10 synthetic requests.",
          method: "Time every request on fixture B.",
        })),
        items: original.items!.map((item) => ({
          ...item,
          outcome: "Current implementation outcome.",
          context: "Current item context.",
          constraints: ["Current item constraint."],
        })),
        agreements: [
          {
            id: "agreement",
            basisId: "discussed",
            targetIds: ["latencyCheck", "latencyGoal", "latencyItem", "requestVisual"],
            note: "The original proposal was agreed in conversation.",
          },
        ],
      };
      await writeFile(json, JSON.stringify(changed));
      await writeFile(html, '<!doctype html><h1 id="request">Current request flow</h1>');
      await cli("plan", "publish", "latency-plan", json, html, "--expected-revision", "2");
      await cli("plan", "capture-basis", "latency-plan", "unreviewed", "--expected-revision", "3");
      const captured = JSON.parse((await cli("plan", "read", "latency-plan")).stdout);
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await page.getByRole("button", { name: "Implement latency", exact: true }).click();
      await retainedDetails(page);
      await page
        .getByRole("button", { name: "Inspect proposal from revision 1", exact: true })
        .click();
      const recorded = page.frameLocator('iframe[title="Recorded proposal from revision 1"]');
      await recorded.getByRole("heading", { name: "Original request flow", exact: true }).waitFor();
      expect(await recorded.locator("body").innerText()).not.toContain(
        "Time every request on fixture A.",
      );
      await page.getByText("Recorded proposal, revision 1", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      expect(await page.locator(".plan-toolbar").innerText()).not.toContain("Recorded proposal");
      expect(
        await page.getByRole("button", { name: "Current proposal", exact: true }).count(),
      ).toBe(0);
      const owned = page.locator("article").getByText("Request latency", { exact: true });
      await owned.click();
      await page
        .locator("article")
        .getByText("Time every request on fixture B.", { exact: true })
        .first()
        .waitFor();
      await page.getByRole("button", { name: "Copy work item", exact: true }).click();
      await page.getByText("Work item copied.", { exact: true }).waitFor();
      const packet = JSON.parse(
        await application.evaluate(({ clipboard }) => clipboard.readText()),
      );
      expect(packet.item.context).toBe("Current item context.");
      expect(packet.ownedChecks[0].method).toBe("Time every request on fixture B.");
      expect(packet.ownedChecks[0].expectation).toBe("Completes within two seconds.");
      expect(packet.recorded.evidence).toEqual([]);
      expect(packet.recorded.bases[0].proposal.checks[0].method).toBe(
        "Time every request on fixture A.",
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await page.setViewportSize({ width: 1366, height: 768 });
        await owned.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            process.env.SCOPE_TEST_SCREENSHOTS,
            "current-work-after-recorded-overview.png",
          ),
        });
      }
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page
        .frameLocator(`iframe[title="${original.title}"]`)
        .getByRole("heading", { name: "Current request flow", exact: true })
        .waitFor();
      const removed: PlanDocument = {
        ...captured.document,
        checks: [],
        visuals: [],
        items: changed.items!.map((item) => ({ ...item, checkIds: [] })),
      };
      await writeFile(json, JSON.stringify(removed));
      await cli("plan", "publish", "latency-plan", json, html, "--expected-revision", "4");
      const beforeInspection = JSON.parse((await cli("plan", "read", "latency-plan")).stdout);
      await application.close();
      application = await launch();
      page = await application.firstWindow();
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await page.getByText("No completion checks defined yet.", { exact: true }).waitFor();
      await inspectWithoutRecords(page, 3, changed, "Current request flow");
      await page
        .frameLocator(`iframe[title="${original.title}"]`)
        .getByRole("heading", { name: "Current request flow", exact: true })
        .waitFor();
      expect(JSON.parse((await cli("plan", "read", "latency-plan")).stdout)).toEqual(
        beforeInspection,
      );
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      expect(
        await page
          .getByRole("button", { name: "Implement latency", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await retainedDetails(page);
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        for (const appearance of ["light", "dark"]) {
          await page.keyboard.press("ControlOrMeta+,");
          await page
            .getByRole("dialog", { name: "Settings", exact: true })
            .getByLabel("Search settings")
            .fill("appearance");
          await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
          await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
          await page
            .getByRole("dialog", { name: "Settings", exact: true })
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await page
            .getByRole("dialog", { name: "Settings", exact: true })
            .waitFor({ state: "hidden" });
          for (const width of [1366, 620]) {
            await page.setViewportSize({ width, height: 768 });
            await page
              .locator(".plan-records")
              .getByRole("list", { name: "Agreement targets" })
              .locator(":scope > li")
              .first()
              .scrollIntoViewIfNeeded();
            expect(
              await page
                .locator(".plan-work")
                .evaluate((element) => element.scrollWidth <= element.clientWidth),
            ).toBe(true);
            await page.screenshot({
              path: join(
                process.env.SCOPE_TEST_SCREENSHOTS,
                `retained-agreement-${appearance}-${width}.png`,
              ),
            });
          }
        }
      }
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
