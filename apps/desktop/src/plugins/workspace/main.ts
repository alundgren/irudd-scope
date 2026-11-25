import { powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import {
  WorkspaceBoardRef,
  WorkspaceCommand,
  WorkspaceRepository,
} from "@irudd-scope/protocol/workspace";
import type { MainPluginContext } from "../main-api.ts";
import { WorkspaceCancelReads, WorkspaceInterestPayload } from "./contract.ts";
import { registerWorkspaceExternalLinks } from "./external-links.ts";
import { WorkspaceSync } from "./sync.ts";

export function registerWorkspaceIpc(context: MainPluginContext) {
  const { handle, artifacts, client, window } = context;
  const links = registerWorkspaceExternalLinks(context);
  const syncing = new WorkspaceSync(artifacts.workspaces);

  const unsubscribe = artifacts.subscribe(() => {
    void syncing.reconcile().catch(() => {});
  });
  const suspend = () => syncing.cancelPending();
  const resume = () => {
    void syncing.resume().catch(() => {});
  };
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  window.webContents.on("destroyed", suspend);
  void syncing.start().catch(() => {});

  handle("scope:workspace-interest", (value) =>
    syncing.interest(decode(WorkspaceInterestPayload, value)),
  );
  artifacts.workspaces.setHandlers({
    sync: (tabId) => syncing.sync(tabId),
    prDetail: (tabId, nodeId, captured, signal) =>
      syncing.prDetail(tabId, nodeId, captured, signal),
    issueDetail: (tabId, nodeId, signal) => syncing.issueDetail(tabId, nodeId, signal),
  });
  handle("scope:workspace-cancel-reads", (value) => {
    const { tabId, requestIds } = decode(WorkspaceCancelReads, value);
    artifacts.workspaces.cancelReads(tabId, requestIds);
  });
  handle("scope:create-workspace", async (value) => {
    const input = decode(
      Schema.Struct({
        name: ArtifactName,
        title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
        html: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
        repository: Schema.optionalKey(WorkspaceRepository),
        board: Schema.optionalKey(Schema.NullOr(WorkspaceBoardRef)),
      }),
      value,
    );
    const artifact = await client.publish(
      randomUUID(),
      {
        name: input.name,
        title: input.title,
        kind: "workspace",
        mediaType: "text/html",
        fileName: `${input.name}.html`,
        expectedRevision: 0,
      },
      Buffer.from(input.html),
    );
    if (input.repository) {
      const owner = await artifacts.workspaces.snapshot(input.name);
      await artifacts.workspaces.command({
        action: "configure",
        name: input.name,
        tabId: owner.tabId,
        requestId: randomUUID(),
        repository: input.repository,
        ...(input.board !== undefined ? { board: input.board } : {}),
      });
    }
    return artifact;
  });
  handle("scope:workspace-command", (value) =>
    artifacts.workspaces.command(decode(WorkspaceCommand, value)),
  );

  return {
    cancelPending: () => syncing.cancelPending(),
    resume: () => syncing.resume(),
    cancelTabs: (ids: readonly string[]) => syncing.cancelTabs(ids),
    dispose: () => {
      links.dispose();
      syncing.cancelPending();
      unsubscribe();
      powerMonitor.removeListener("suspend", suspend);
      powerMonitor.removeListener("resume", resume);
      window.webContents.removeListener("destroyed", suspend);
      artifacts.workspaces.setHandlers(undefined);
    },
  };
}
