import { expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import type { Tab } from "../apps/desktop/src/workspace/contract.ts";

test("legacy plan conversion preserves bytes, workspace identity, old state, order and lifecycle across two restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-migration-"));
  const token = "synthetic-plan-migration-token";
  const artifactDirectory = join(directory, "artifacts");
  const desktop = new DesktopStore(directory);
  await desktop.load();
  let server = await startArtifactServer({ directory: artifactDirectory, token, port: 0 });
  try {
    const client = new ScopeClient(server.url, token);
    const groupId = randomUUID();
    const tabs: Tab[] = [];
    for (const [index, id] of ["visible", "hidden", "trashed"].entries()) {
      const artifact = await client.publish(
        id,
        {
          kind: "plan",
          mediaType: "text/html",
          title: `Legacy ${id}`,
          name: `legacy-${id}`,
          fileName: "legacy.html",
          expectedRevision: 0,
        },
        new TextEncoder().encode(`<h1>Original ${id}</h1><script>window.example=1</script>`),
      );
      const row = (await server.store.tabs()).find((x) => x.artifact_id === id)!;
      tabs.push({
        id: row.id,
        groupId,
        type: "plan",
        title: artifact.title,
        state: { version: 1, data: { artifactId: id, reviewOpen: true, revision: 7 } },
        overlayPositions: { planControls: { x: 10, y: 20 }, planReview: { x: 30, y: 40 } },
        hidden: index === 1,
      });
      await server.store.openTab(tabs[index], artifact.revision);
      if (index === 1) await server.store.setTabPermanent(row.id, false);
      if (index === 2) await server.store.trashTab(row.id);
    }
    await desktop.saveLayout({
      groups: [{ id: groupId, owner: { kind: "workspace", id: groupId } }],
      selected: tabs[0].id,
    });
    const before = await server.store.tabs();
    await server.close();
    const db = new DatabaseSync(join(artifactDirectory, "scope.db"));
    db.exec(
      "UPDATE artifacts SET document=json_set(document,'$.kind','plan'); PRAGMA user_version = 15",
    );
    db.close();
    for (let restart = 0; restart < 2; restart++) {
      server = await startArtifactServer({ directory: artifactDirectory, token, port: 0 });
      const lifecycle = new DesktopLifecycle(server.store, desktop);
      await lifecycle.recover();
      const workspace = await lifecycle.workspace();
      expect(workspace.tabs.map((x) => x.id)).toEqual(tabs.slice(0, 2).map((x) => x.id));
      expect(workspace.selected).toBe(tabs[0].id);
      expect(workspace.tabs[1].hidden).toBe(true);
      for (const tab of workspace.tabs) {
        expect(tab.type).toBe("file");
        expect(tab.state.data).toMatchObject({ reviewOpen: true, revision: 7 });
        expect(tab.overlayPositions).toEqual(tabs[0].overlayPositions);
      }
      await lifecycle.saveWorkspace(workspace);
      const after = await server.store.tabs();
      for (const row of before) {
        const converted = after.find((x) => x.id === row.id)!;
        expect(converted).toMatchObject({
          artifact_id: row.artifact_id,
          position: row.position,
          permanent: row.permanent,
          trashed_at: row.trashed_at,
          opened: row.opened,
        });
        const artifact = await server.store.get(row.artifact_id!);
        expect(artifact).toMatchObject({
          id: row.artifact_id,
          name: `legacy-${row.artifact_id}`,
          kind: "html",
          revision: 1,
        });
        expect(
          Buffer.from(await new ScopeClient(server.url, token).content(artifact.id)).toString(),
        ).toBe(`<h1>Original ${row.artifact_id}</h1><script>window.example=1</script>`);
      }
      await server.close();
    }
  } finally {
    await server.close();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
