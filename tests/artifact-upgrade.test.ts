import { expect, test } from "vite-plus/test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "existing copied artifacts retain their identities, bytes, titles and retention when Scope opens",
  { tags: ["survives-restart", "publish", "bad-requests-change-nothing"], timeout: 90_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let app = await f.launch();
    try {
      await f.cli(
        "text",
        "Ordinary published content",
        "--id",
        "ordinary",
        "--title",
        "Ordinary note",
      );
      const client = await f.connect();
      const ordinary = await client.get("ordinary");
      const page = await app.firstWindow();
      await page.getByRole("tab", { name: "Ordinary note", exact: false }).waitFor();
      const workspace = await page.evaluate(() => window.scope.workspace());
      if (!workspace) throw new Error("Workspace was not saved.");
      await app.close();
      const filename = join(f.settingsDirectory, "artifacts", "scope.db");
      const db = new DatabaseSync(filename);
      const copied = [false, true].map((permanent) => {
        const id = `transfer-${randomUUID()}`;
        const bytes = Buffer.from(`Preserved copied content: ${permanent}`);
        const artifact = {
          ...ordinary,
          id,
          title: permanent ? "Bookmarked received note" : "Temporary received note",
          size: bytes.length,
          blob: createHash("sha256").update(bytes).digest("hex"),
        };
        const tab = {
          id: randomUUID(),
          groupId: workspace.groups[0].id,
          type: "file",
          title: artifact.title,
          state: { version: 1, data: { artifactId: id } },
          hidden: true,
        };
        return { artifact, tab, bytes, permanent };
      });
      const remote = {
        id: randomUUID(),
        name: "Saved remote",
        endpoint: "https://remote.example.test",
        enabled: false,
      };
      const preferences = new DatabaseSync(join(f.settingsDirectory, "desktop.db"));
      try {
        preferences
          .prepare("INSERT INTO preferences(name, document) VALUES ('remotes', ?)")
          .run(JSON.stringify([remote]));
        preferences
          .prepare("INSERT INTO preferences(name, document) VALUES ('transfer-device', ?)")
          .run('{"obsolete":true}');
        preferences
          .prepare("INSERT INTO preferences(name, document) VALUES ('scope-peers', ?)")
          .run('{"obsolete":true}');
      } finally {
        preferences.close();
      }
      let before: unknown;
      let version: unknown;
      try {
        // These are the ordinary records and retry receipt written by earlier copies.
        db.exec(
          "CREATE TABLE transfer_receipts (source_id TEXT NOT NULL, invitation_id TEXT NOT NULL, expires_at INTEGER NOT NULL, artifact TEXT NOT NULL CHECK(json_valid(artifact)), tab TEXT NOT NULL CHECK(json_valid(tab)), PRIMARY KEY(source_id, invitation_id)) STRICT",
        );
        for (const { artifact, tab, bytes, permanent } of copied) {
          const now = Date.now();
          db.prepare(
            "INSERT INTO live_tabs(id, artifact_id, opened, created_at, document, position, last_visible_at, permanent) VALUES (?, ?, 1, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM live_tabs), ?, ?)",
          ).run(tab.id, artifact.id, now, JSON.stringify(tab), now, Number(permanent));
          db.prepare("INSERT INTO blobs(id, content) VALUES (?, ?)").run(artifact.blob, bytes);
          db.prepare("INSERT INTO tab_blobs VALUES (?, ?, 0)").run(tab.id, artifact.blob);
          db.prepare(
            "INSERT INTO artifacts(id, revision, document, tab_id, blob_id) VALUES (?, ?, ?, ?, ?)",
          ).run(artifact.id, artifact.revision, JSON.stringify(artifact), tab.id, artifact.blob);
          db.prepare("INSERT INTO transfer_receipts VALUES (?, ?, ?, ?, ?)").run(
            randomUUID(),
            randomUUID(),
            now - 1,
            JSON.stringify(artifact),
            JSON.stringify(tab),
          );
        }
        before = db
          .prepare(
            "SELECT id, artifact_id, permanent, trashed_at, last_visible_at FROM live_tabs WHERE artifact_id LIKE 'transfer-%' ORDER BY id",
          )
          .all();
        version = db.prepare("PRAGMA user_version").get();
      } finally {
        db.close();
      }
      app = await f.launch();
      const reopened = await f.connect();
      expect(await reopened.get("ordinary")).toEqual(ordinary);
      expect(Buffer.from(await reopened.content("ordinary")).toString()).toBe(
        "Ordinary published content",
      );
      for (const { artifact, bytes } of copied) {
        expect(await reopened.get(artifact.id)).toEqual(artifact);
        expect(Buffer.from(await reopened.content(artifact.id))).toEqual(bytes);
      }
      const currentPage = await app.firstWindow();
      const current = await currentPage.evaluate(() => window.scope.workspace());
      if (!current) throw new Error("Workspace was not restored.");
      for (const { tab } of copied)
        expect(current.tabs.find((entry) => entry.id === tab.id)).toMatchObject(tab);
      await currentPage.getByRole("button", { name: "Search and controls" }).click();
      expect(await currentPage.getByRole("button", { name: "Send tab", exact: true }).count()).toBe(
        0,
      );
      expect(
        await currentPage.getByRole("button", { name: "Import tab", exact: true }).count(),
      ).toBe(0);
      const { endpoint, token } = JSON.parse(await readFile(f.connectionFile, "utf8"));
      const response = await fetch(`${endpoint}/v1/transfers/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "scope-transfer://v2/#retired" }),
      });
      expect(response.status).toBe(404);
      expect((await f.cli("--help")).stdout.toLowerCase()).not.toContain("import-link");
      await expect(f.cli("import-link", "scope-transfer://v2/#retired")).rejects.toThrow();
      await app.close();
      const after = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          after
            .prepare(
              "SELECT id, artifact_id, permanent, trashed_at, last_visible_at FROM live_tabs WHERE artifact_id LIKE 'transfer-%' ORDER BY id",
            )
            .all(),
        ).toEqual(before);
        expect(after.prepare("PRAGMA user_version").get()).toEqual(version);
        expect(after.prepare("SELECT count(*) AS n FROM transfer_receipts").get()?.n).toBe(2);
      } finally {
        after.close();
      }
      const saved = new DatabaseSync(join(f.settingsDirectory, "desktop.db"), { readOnly: true });
      try {
        expect(
          JSON.parse(
            String(
              saved.prepare("SELECT document FROM preferences WHERE name='remotes'").get()
                ?.document,
            ),
          ),
        ).toEqual([remote]);
        expect(
          saved.prepare("SELECT document FROM preferences WHERE name='transfer-device'").get()
            ?.document,
        ).toBe('{"obsolete":true}');
        expect(
          saved.prepare("SELECT document FROM preferences WHERE name='scope-peers'").get()
            ?.document,
        ).toBe('{"obsolete":true}');
      } finally {
        saved.close();
      }
    } finally {
      await app.close().catch(() => {});
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
