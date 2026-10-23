import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { readPlan, type PlanDocument } from "@irudd-scope/protocol/plan";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

const exec = promisify(execFile);
const examples = resolve(".agents/skills/irudd-scope/examples/plans");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-structured-plan-"));
  const token = "synthetic-structured-plan-token";
  const server = await startArtifactServer({ directory, token, port: 0 });
  const client = new ScopeClient(server.url, token);
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
          env: {
            ...process.env,
            SCOPE_ENDPOINT: server.url,
            SCOPE_TOKEN: token,
            SCOPE_TOKEN_FILE: undefined,
          },
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout,
    );
  return {
    directory,
    server,
    client,
    cli,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each(["ui", "non-ui"])(
  "built CLI publishes %s plan and exports independent packets and exact HTML",
  async (folder) => {
    const f = await fixture();
    try {
      const html = join(examples, folder, "overview.html");
      const first = await f.cli(
        "plan",
        "publish",
        "sample-plan",
        join(examples, folder, "plan.json"),
        html,
      );
      expect(first).toMatchObject({ revision: 1, kind: "plan", mediaType: "application/json" });
      const read = await f.cli("plan", "read", "sample-plan");
      expect(read.document.overviewHtml).toBe(await readFile(html, "utf8"));
      const packet = await f.cli("plan", "item", "sample-plan", "recover");
      expect(packet.ownedChecks).toHaveLength(1);
      expect(packet.prerequisites).toHaveLength(1);
      expect(packet.prerequisites[0].checks).toHaveLength(2);
      const invalidFile = join(f.directory, "invalid.json");
      await writeFile(
        invalidFile,
        JSON.stringify({
          ...read.document,
          items: [{ ...read.document.items[0], checkIds: ["missing"] }],
        }),
      );
      await expect(
        f.cli("plan", "publish", "sample-plan", invalidFile, html, "--expected-revision", "1"),
      ).rejects.toThrow("Unknown check");
      const output = join(f.directory, "overview.html");
      await f.cli("plan", "content", "sample-plan", "--output", output);
      expect(await readFile(output, "utf8")).toBe(read.document.overviewHtml);
      await expect(f.cli("plan", "content", "sample-plan", "--output", output)).rejects.toThrow();
      await expect(f.cli("update", "sample-plan", html)).rejects.toThrow("plan publish");
      await expect(
        f.cli("plan", "publish", "sample-plan", join(examples, folder, "plan.json"), html),
      ).rejects.toThrow();
      await expect(
        f.client.publish(
          first.id,
          {
            name: first.name,
            title: first.title,
            fileName: "old.html",
            expectedRevision: 1,
            kind: "plan",
            mediaType: "text/html",
          },
          new TextEncoder().encode("<h1>Downgrade</h1>"),
        ),
      ).rejects.toThrow();
      expect((await f.client.get(first.id)).revision).toBe(1);
      expect((await f.server.store.tabs())[0].permanent).toBe(1);
    } finally {
      await f.close();
    }
  },
);

test("publication preserves exact bases and records after changed and removed criteria, rejecting bypasses atomically", async () => {
  const f = await fixture();
  try {
    const html = join(examples, "ui", "overview.html");
    const first = await f.cli(
      "plan",
      "publish",
      "recorded-plan",
      join(examples, "ui", "plan.json"),
      html,
    );
    await f.cli("plan", "capture-basis", "recorded-plan", "discussed", "--expected-revision", "1");
    let current = await f.client.get(first.id);
    let plan = readPlan(await f.client.content(first.id));
    const proposal = plan.bases![0].proposal;
    plan = {
      ...plan,
      agreements: [
        {
          id: "agreed",
          basisId: "discussed",
          targetIds: ["save"],
          note: "The reader explicitly agreed to keeping one saved entry.",
        },
      ],
      evidence: [
        {
          id: "tested",
          basisId: "discussed",
          checkId: "save",
          expected: "One saved entry",
          observed: "One entry after restart",
          implementation: "Synthetic build",
          conditions: "Empty list",
          result: "passed",
          references: ["synthetic-run.txt"],
        },
      ],
    };
    const publish = (next: PlanDocument, revision = current.revision) =>
      f.client.publish(
        first.id,
        {
          name: "recorded-plan",
          title: next.title,
          kind: "plan",
          mediaType: "application/json",
          fileName: "plan.json",
          expectedRevision: revision,
        },
        new TextEncoder().encode(JSON.stringify(next)),
      );
    current = await publish(plan);
    const before = Buffer.from(await f.client.content(first.id));
    for (const bad of [
      { ...plan, bases: [] },
      {
        ...plan,
        bases: [
          {
            ...plan.bases![0],
            proposal: { ...proposal, overviewHtml: proposal.overviewHtml + "<!-- changed -->" },
          },
        ],
      },
      { ...plan, checks: plan.checks!.map((x) => ({ ...x, expectation: "x".repeat(262145) })) },
      { ...plan, checks: plan.checks!.map((x) => ({ ...x, goalIds: ["missing"] })) },
      {
        ...plan,
        items: [],
        checks: plan.checks!.map((x) => ({ ...x, placement: "work" as const })),
        visuals: [],
      },
      { ...plan, visuals: plan.visuals!.map((x) => ({ ...x, anchor: "absent" })) },
      { ...plan, agreements: [] },
      { ...plan, evidence: [] },
      { ...plan, checks: [...plan.checks!, plan.checks![0]] },
      { ...plan, items: plan.items!.map((x) => ({ ...x, dependsOn: [x.id] })) },
      { ...plan, items: plan.items!.map((x) => ({ ...x, checkIds: ["missing"] })) },
      { ...plan, evidence: [{ ...plan.evidence![0], checkId: "missing" }] },
      {
        ...plan,
        bases: [
          ...plan.bases!,
          {
            id: "invented",
            revision: 1,
            proposal: { ...proposal, overviewHtml: proposal.overviewHtml + "<!-- fabricated -->" },
          },
        ],
      },
    ]) {
      await expect(publish(bad)).rejects.toThrow();
      expect(Buffer.from(await f.client.content(first.id))).toEqual(before);
      expect((await f.client.get(first.id)).revision).toBe(current.revision);
    }
    await expect(publish(plan, 1)).rejects.toThrow();
    const changed = {
      ...plan,
      overviewHtml: '<h1 id="ordinary-case">New visual</h1><div id="recovery-case"></div>',
      checks: plan.checks!.filter((x) => x.id !== "save"),
      visuals: plan.visuals!.map((x) => ({
        ...x,
        checkIds: x.checkIds.filter((id) => id !== "save"),
      })),
      items: plan.items!.map((x) => ({ ...x, checkIds: x.checkIds.filter((id) => id !== "save") })),
    };
    current = await publish(changed);
    const packet = await f.cli("plan", "item", "recorded-plan", "persist");
    expect(packet.ownedChecks.map((x: { id: string }) => x.id)).not.toContain("save");
    expect(packet.recorded.bases[0].proposal).toEqual(proposal);
    expect(packet.recorded.evidence[0].checkId).toBe("save");
    expect(packet.overviewHtml).toBe(
      '<h1 id="ordinary-case">New visual</h1><div id="recovery-case"></div>',
    );
    current = await publish({ ...changed, agreements: [], removedRecordIds: ["agreed"] });
    expect(readPlan(await f.client.content(first.id)).bases![0].proposal).toEqual(proposal);
  } finally {
    await f.close();
  }
});
