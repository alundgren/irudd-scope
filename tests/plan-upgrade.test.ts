import { expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "version 1 plans convert on upgrade, keeping their tab and only evidence for unchanged checks",
  { tags: ["survives-restart", "tabs-stay-put"], timeout: 120_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      const example = resolve(".agents/skills/irudd-scope/examples/plans/ui");
      const artifact = JSON.parse(
        (
          await f.cli(
            "plan",
            "publish",
            "upgraded-plan",
            join(example, "plan.json"),
            join(example, "overview.html"),
          )
        ).stdout,
      );
      await page.getByRole("tab", { name: "Save a reading list", exact: true }).click();
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await page.getByRole("button", { name: "Persist the reading list", exact: true }).click();
      await expect
        .poll(async () =>
          page.evaluate(
            async () =>
              (await window.scope.workspace())?.tabs.find((x) => x.type === "plan")?.state.data
                .itemId,
          ),
        )
        .toBe("persist");
      const tabId = await page
        .getByRole("tab", { name: "Save a reading list", exact: true })
        .getAttribute("id");
      await application.close();

      // Recreate a schema-17 database holding the same plan in format version 1.
      const db = new DatabaseSync(join(f.settingsDirectory, "artifacts", "scope.db"));
      try {
        const row = db
          .prepare("SELECT tab_id, document FROM artifacts WHERE id = ?")
          .get(artifact.id) as { tab_id: string; document: string };
        const current = JSON.parse(
          Buffer.from(
            (
              db
                .prepare("SELECT content FROM blobs WHERE id = ?")
                .get(JSON.parse(row.document).blob) as { content: Uint8Array }
            ).content,
          ).toString(),
        );
        const { version: _version, ...proposal } = current;
        const recorded = {
          ...proposal,
          checks: proposal.checks.map((x: { id: string; method: string }) =>
            x.id === "repeat" ? { ...x, method: "An earlier procedure." } : x,
          ),
        };
        const record = (id: string, checkId: string) => ({
          id,
          basisId: "tested",
          checkId,
          expected: "Expected",
          observed: `Observed ${checkId}`,
          implementation: "Synthetic build",
          conditions: "Synthetic fixture",
          result: "passed",
        });
        const v1 = {
          ...proposal,
          version: 1,
          bases: [{ id: "tested", revision: 1, proposal: recorded }],
          agreements: [{ id: "agreed", basisId: "tested", targetIds: ["save"], note: "Agreed." }],
          evidence: [record("kept", "save"), record("dropped", "repeat")],
          removedRecordIds: ["older"],
        };
        const bytes = Buffer.from(JSON.stringify(v1));
        const blob = createHash("sha256").update(bytes).digest("hex");
        db.prepare("INSERT INTO blobs(id, content) VALUES (?, ?)").run(blob, bytes);
        db.prepare("INSERT INTO tab_blobs VALUES (?, ?, 0)").run(row.tab_id, blob);
        db.prepare("UPDATE artifacts SET document = ?, blob_id = ? WHERE id = ?").run(
          JSON.stringify({ ...JSON.parse(row.document), blob, size: bytes.byteLength }),
          blob,
          artifact.id,
        );
        db.exec("PRAGMA user_version = 17");
      } finally {
        db.close();
      }

      application = await f.launch();
      page = await application.firstWindow();
      const upgraded = new DatabaseSync(join(f.settingsDirectory, "artifacts", "scope.db"));
      try {
        expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
      } finally {
        upgraded.close();
      }
      const read = JSON.parse((await f.cli("plan", "read", "upgraded-plan")).stdout);
      expect(read.artifact.revision).toBe(artifact.revision + 1);
      expect(read.document.version).toBe(2);
      for (const key of ["bases", "agreements", "removedRecordIds", "doneItemIds"])
        expect(read.document).not.toHaveProperty(key);
      expect(read.document.evidence.map((x: { id: string }) => x.id)).toEqual(["kept"]);
      const item = JSON.parse((await f.cli("plan", "item", "upgraded-plan", "persist")).stdout);
      expect(item.item.done).toBe(false);
      expect(item.checks.map((x: { state: string }) => x.state)).toEqual(["passed", "none"]);

      const tab = page.getByRole("tab", { name: "Save a reading list", exact: true });
      await tab.click();
      expect(await tab.getAttribute("id")).toBe(tabId);
      expect(
        await page
          .getByRole("button", { name: "Persist the reading list", exact: true })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
