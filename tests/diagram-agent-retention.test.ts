import { expect, test, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { connectedDiagramAgents } from "../apps/desktop/src/plugins/diagram/connected-agent.ts";
import type { DiagramDraft } from "../apps/desktop/src/plugins/diagram/draft.ts";
import { TEMPORARY_RETENTION_MS } from "../apps/desktop/src/workspace/retention.ts";

test.each(["close", "expiry"] as const)(
  "%s invalidates delivered agent requests before refreshing Trashcan and preserves the restored draft",
  async (action) => {
    const directory = await mkdtemp(join(tmpdir(), "scope-agent-retention-"));
    const desktop = new DesktopStore(directory);
    await desktop.load();
    const token = "synthetic-agent-retention-token";
    let agents!: ReturnType<typeof connectedDiagramAgents>;
    let lifecycle!: DesktopLifecycle;
    const server = await startArtifactServer({
      directory: join(directory, "artifacts"),
      port: 0,
      token,
      initialize: async (store) => {
        lifecycle = new DesktopLifecycle(store, desktop);
        await lifecycle.recover();
      },
      diagramAgent: (command, signal) => agents.run(command, signal),
    });
    let release = () => {};
    let closing: Promise<void> | undefined;
    try {
      const client = new ScopeClient(server.url, token);
      const content = '{"type":"excalidraw","elements":[],"files":{}}';
      const artifact = await client.publish(
        "retained",
        {
          title: "Retained diagram",
          kind: "excalidraw",
          mediaType: "application/vnd.excalidraw+json",
          fileName: "retained.excalidraw",
          expectedRevision: 0,
        },
        Buffer.from(content),
      );
      const workspace = await lifecycle.workspace();
      const tab = await lifecycle.openTab(
        {
          id: crypto.randomUUID(),
          groupId: workspace.groups[0].id,
          type: "diagram",
          title: artifact.title,
          state: { version: 1, data: { artifactId: artifact.id } },
        },
        artifact.revision,
      );
      if (!tab) throw new Error("The diagram did not open.");
      const draft: DiagramDraft = {
        version: 1,
        content,
        revision: artifact.revision,
        dirty: false,
        messages: [],
        intent: "Keep this prompt",
        chatOpen: true,
      };
      await server.store.saveDiagramDraft(tab.id, draft);
      agents = connectedDiagramAgents(
        async (command) => {
          if (command.action === "apply") {
            // Model the renderer's draft-first save before publishing its new revision.
            const edited = JSON.stringify({
              type: "excalidraw",
              elements: [{ id: "late", type: "text", text: "Late edit" }],
              files: {},
            });
            await server.store.saveDiagramDraft(tab.id, { ...draft, content: edited, dirty: true });
            await server.store.replaceContent(
              artifact.id,
              artifact.revision,
              artifact.title,
              Buffer.from(edited),
            );
          }
          return {
            type: "snapshot",
            diagram: {
              id: artifact.id,
              revision: artifact.revision,
              snapshot: "a".repeat(64),
              dirty: false,
              scene: { nodes: [], texts: [], connections: [], groups: [] },
              selectedIds: [],
              readOnly: [],
              omitted: 0,
            },
          };
        },
        () => {},
        async () => (await lifecycle.workspace()).tabs.find((entry) => entry.id === tab.id)?.id,
      );
      lifecycle.onRemoved = agents.cancelTabs;
      const waiting = client.diagramAgent({ action: "wait", id: artifact.id, name: "Agent" });
      void waiting.catch(() => {});
      await expect.poll(() => agents.status(artifact.id).phase).toBe("waiting");
      const sent = agents.request({ id: artifact.id, intent: "Add a label.", history: [] });
      void sent.catch(() => {});
      const request = await waiting;
      if (request.type !== "request") throw new Error("Expected a delivered request.");
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      release = () => gate.resolve();
      const retainedTabs = server.store.retainedTabs.bind(server.store);
      vi.spyOn(server.store, "retainedTabs").mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        return retainedTabs();
      });
      closing =
        action === "close"
          ? lifecycle.closeTab(tab.id)
          : lifecycle.checkRetention([], Date.now() + TEMPORARY_RETENTION_MS + 1);
      await started.promise;
      expect((await retainedTabs())[0].trashedAt).not.toBeNull();
      const reply = await client
        .diagramAgent({
          action: "reply",
          id: artifact.id,
          requestId: request.requestId,
          token: request.token,
          snapshot: request.diagram.snapshot,
          message: "Added the label",
          operations: [{ type: "createText", id: "late", text: "Late edit", x: 100, y: 100 }],
        })
        .catch((error: unknown) => error);
      release();
      await closing;
      expect((await lifecycle.restoreTab(tab.id)).id).toBe(tab.id);
      expect(await server.store.diagramDraft(tab.id)).toEqual(draft);
      expect(Buffer.from(await client.content(artifact.id)).toString()).toBe(content);
      expect(reply).toMatchObject({ status: 409, message: expect.stringContaining("expired") });
      await expect(sent).rejects.toThrow("tab closed");
    } finally {
      release();
      await closing;
      agents?.close();
      await server.close();
      await desktop.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
