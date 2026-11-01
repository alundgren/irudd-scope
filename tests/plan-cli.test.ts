import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { readPlan, type PlanDocument } from "@irudd-scope/protocol/plan";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

const examples = resolve(".agents/skills/irudd-scope/examples/plans");
const executable = resolve("packages/cli/dist/main.mjs");
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-cli-"));
  const token = "synthetic-plan-cli-token";
  const server = await startArtifactServer({ directory, token, port: 0 });
  const env = {
    ...process.env,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: token,
    SCOPE_TOKEN_FILE: undefined,
    SCOPE_CONNECTION_FILE: undefined,
  };
  const cli = async (...args: string[]) =>
    JSON.parse((await exec(process.execPath, [executable, ...args], { env })).stdout);
  return {
    directory,
    client: new ScopeClient(server.url, token),
    cli,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  "agents read one work item, record evidence and progress, and plan revisions keep progress honest",
  { tags: ["publish", "no-lost-updates", "bad-requests-change-nothing"] },
  async () => {
    const f = await fixture();
    try {
      const html = join(examples, "ui", "overview.html");
      const first = await f.cli(
        "plan",
        "publish",
        "work-plan",
        join(examples, "ui", "plan.json"),
        html,
      );
      const output = join(f.directory, "exported.html");
      await f.cli("plan", "content", "work-plan", "--output", output);
      expect(await readFile(output, "utf8")).toBe(await readFile(html, "utf8"));
      await expect(f.cli("plan", "content", "work-plan", "--output", output)).rejects.toThrow();
      await expect(f.cli("update", "work-plan", html)).rejects.toThrow("plan publish");

      // The next item comes with only its own checks and its dependencies' titles.
      let next = await f.cli("plan", "next", "work-plan");
      expect(next.items).toEqual([
        { id: "persist", title: expect.any(String), done: false, dependsOn: [] },
        { id: "recover", title: expect.any(String), done: false, dependsOn: ["persist"] },
      ]);
      expect(next.next.item.id).toBe("persist");
      expect(next.next.checks.map((x: { id: string }) => x.id)).toEqual(["save", "repeat"]);
      expect(next.next.checks.every((x: { state: string }) => x.state === "none")).toBe(true);
      expect(next.next.overviewHtml).toBe(await readFile(html, "utf8"));
      expect(JSON.stringify(next.next)).not.toContain('"remove"');

      const evidence = (check: string, result: string) =>
        f.cli(
          "plan",
          "evidence",
          "work-plan",
          check,
          "--result",
          result,
          "--observed",
          `Observed ${check}`,
          "--implementation",
          "Synthetic build",
          "--conditions",
          "Empty list",
          "--reference",
          "synthetic-run.txt",
        );
      expect(await evidence("save", "passed")).toMatchObject({ check: "save", result: "passed" });
      await evidence("repeat", "failed");
      await evidence("repeat", "passed");
      await expect(evidence("missing", "passed")).rejects.toThrow("Check not found");
      await expect(evidence("save", "maybe")).rejects.toThrow("--result");
      const done = await f.cli("plan", "done", "work-plan", "persist");
      expect(done).toMatchObject({ item: "persist", done: true });
      expect(Object.keys(done.receipt)).toEqual(["revision"]);
      await expect(f.cli("plan", "done", "work-plan", "missing")).rejects.toThrow(
        "Work item not found",
      );

      const item = await f.cli("plan", "item", "work-plan", "persist");
      expect(item.item.done).toBe(true);
      expect(item.checks.map((x: { state: string }) => x.state)).toEqual(["passed", "passed"]);
      expect(item.checks[0].evidence.references).toEqual(["synthetic-run.txt"]);
      next = await f.cli("plan", "next", "work-plan");
      expect(next.next.item.id).toBe("recover");
      expect(next.next.dependencies).toEqual([
        { id: "persist", title: next.items[0].title, done: true },
      ]);

      // A planning agent republishes the whole document; changing a done item's check reopens it.
      const read = await f.cli("plan", "read", "work-plan");
      const plan: PlanDocument = read.document;
      const publish = (body: unknown, revision: number) =>
        f.client.publish(
          first.id,
          {
            name: "work-plan",
            title: plan.title,
            kind: "plan",
            mediaType: "application/json",
            fileName: "plan.json",
            expectedRevision: revision,
          },
          new TextEncoder().encode(JSON.stringify(body)),
        );
      const before = Buffer.from(await f.client.content(first.id));
      await expect(publish({ ...plan, version: 1 }, read.artifact.revision)).rejects.toThrow(
        "Update the irudd-scope CLI",
      );
      await expect(
        publish({ ...plan, context: "Older read" }, read.artifact.revision - 1),
      ).rejects.toThrow();
      expect(Buffer.from(await f.client.content(first.id))).toEqual(before);
      const revised = {
        ...plan,
        context: "Revised after review",
        checks: plan.checks!.map((check) =>
          check.id === "repeat" ? { ...check, method: `${check.method} Twice.` } : check,
        ),
      };
      await publish(revised, read.artifact.revision);
      const settled = readPlan(await f.client.content(first.id));
      expect(settled.context).toBe("Revised after review");
      expect(settled.doneItemIds ?? []).toEqual([]);
      const reopened = await f.cli("plan", "item", "work-plan", "persist");
      expect(reopened.item.done).toBe(false);
      expect(reopened.checks.map((x: { state: string }) => x.state)).toEqual(["passed", "stale"]);

      await f.cli("plan", "done", "work-plan", "persist");
      await f.cli("plan", "reopen", "work-plan", "persist");
      expect((await f.cli("plan", "items", "work-plan")).items[0].done).toBe(false);
    } finally {
      await f.close();
    }
  },
);
