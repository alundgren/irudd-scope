import { expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "legacy plans reopen as HTML without losing content, tab identity, hidden tabs or trash",
  { tags: ["survives-restart", "tabs-stay-put", "deletion-is-final"], timeout: 120_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      for (const id of ["visible", "hidden", "trashed"]) {
        const file = join(f.directory, `${id}.html`);
        await writeFile(
          file,
          `<h1>Original ${id}</h1><button onclick="this.textContent='Works'">Try</button>`,
        );
        const artifact = JSON.parse(
          (
            await f.cli(
              "add",
              file,
              "--plan",
              "--id",
              id,
              "--name",
              `legacy-${id}`,
              "--title",
              `Legacy ${id}`,
            )
          ).stdout,
        );
        expect(artifact.kind).toBe("html");
        await page.getByRole("tab", { name: `Legacy ${id}`, exact: true }).click();
      }
      await page.getByRole("tab", { name: "Legacy trashed", exact: true }).focus();
      await page.keyboard.press("Delete");
      await page
        .getByRole("tab", { name: "Legacy trashed", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("tab", { name: "Legacy hidden", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+w");
      await page
        .getByRole("tab", { name: "Legacy hidden", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("tab", { name: "Legacy visible", exact: true }).click();
      const before = await page.evaluate(async () =>
        (await window.scope.retainedTabs()).filter((x) => x.tab.title.startsWith("Legacy ")),
      );
      const selected = await page
        .getByRole("tab", { name: "Legacy visible", exact: true })
        .getAttribute("id");
      await application.close();

      // Recreate the schema-15 input in an isolated profile. The new executable
      // performs the upgrade; observations use its UI and publication API.
      const db = new DatabaseSync(join(f.settingsDirectory, "artifacts", "scope.db"));
      try {
        db.exec(
          "UPDATE artifacts SET document=json_set(document,'$.kind','plan') WHERE id IN ('visible','hidden','trashed'); UPDATE live_tabs SET document=json_set(document,'$.type','plan') WHERE artifact_id IN ('visible','hidden','trashed'); PRAGMA user_version=15",
        );
      } finally {
        db.close();
      }
      for (let restart = 0; restart < 2; restart++) {
        application = await f.launch();
        page = await application.firstWindow();
        const client = await f.connect();
        const tab = page.getByRole("tab", { name: "Legacy visible", exact: true });
        await tab.waitFor();
        expect(await tab.getAttribute("id")).toBe(selected);
        expect(await tab.getAttribute("aria-selected")).toBe("true");
        const after = await page.evaluate(async () =>
          (await window.scope.retainedTabs()).filter((x) => x.tab.title.startsWith("Legacy ")),
        );
        expect(
          after.map(({ tab, permanent, trashedAt }) => ({ tab, permanent, trashedAt })),
        ).toEqual(before.map(({ tab, permanent, trashedAt }) => ({ tab, permanent, trashedAt })));
        expect(after.every((x) => x.tab.type === "file")).toBe(true);
        expect(await page.getByRole("tab", { name: "Legacy hidden", exact: true }).count()).toBe(0);
        expect(await page.getByRole("tab", { name: "Legacy trashed", exact: true }).count()).toBe(
          0,
        );
        for (const id of ["visible", "hidden", "trashed"]) {
          expect(await client.get(id)).toMatchObject({
            id,
            name: `legacy-${id}`,
            kind: "html",
            revision: 1,
          });
          expect(Buffer.from(await client.content(id)).toString()).toBe(
            `<h1>Original ${id}</h1><button onclick="this.textContent='Works'">Try</button>`,
          );
        }
        const frame = page.frameLocator('iframe[title="Legacy visible"]');
        await frame.getByRole("button", { name: "Try", exact: true }).click();
        await frame.getByRole("button", { name: "Works", exact: true }).waitFor();
        if (restart === 0) await application.close();
      }
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
