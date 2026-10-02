import { powerMonitor } from "electron";
import { PullRequestsInterest } from "./interest.ts";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import { PullRequestsCommand, PullRequestsRepository } from "@irudd-scope/protocol/pull-requests";
import type { MainPluginContext } from "../main-api.ts";
import { PullRequestSync } from "./sync.ts";

export function registerPullRequestsIpc({ handle, artifacts, client, window }: MainPluginContext) {
  const syncing = new PullRequestSync(artifacts.pullRequests, undefined, {
    onDetail: (update) => {
      if (!window.isDestroyed())
        window.webContents.send("scope:pull-requests-detail-update", update);
    },
  });
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
  handle("scope:pull-requests-interest", (value) =>
    syncing.interest(decode(PullRequestsInterest, value)),
  );
  artifacts.pullRequests.setHandlers({
    sync: (tabId) => syncing.sync(tabId),
    detail: (tabId, nodeId) => syncing.detail(tabId, nodeId),
  });
  handle("scope:create-pull-requests", async (value) => {
    const input = decode(
      Schema.Struct({
        name: ArtifactName,
        title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
        html: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
        repository: PullRequestsRepository,
      }),
      value,
    );
    const artifact = await client.publish(
      randomUUID(),
      {
        name: input.name,
        title: input.title,
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: `${input.name}.html`,
        expectedRevision: 0,
      },
      Buffer.from(input.html),
    );
    const owner = await artifacts.pullRequests.snapshot(input.name);
    if (owner.artifact.id !== artifact.id || owner.artifact.revision !== artifact.revision)
      throw new Error("This pull request tab changed while being created. Open the current tab.");
    await artifacts.pullRequests.command({
      action: "configure",
      name: input.name,
      tabId: owner.tabId,
      requestId: randomUUID(),
      repository: input.repository,
    });
    return artifact;
  });
  handle("scope:pull-requests-command", (value) =>
    artifacts.pullRequests.command(decode(PullRequestsCommand, value)),
  );
  return {
    cancelPending: () => syncing.cancelPending(),
    resume: () => syncing.resume(),
    cancelTabs: (ids: readonly string[]) => syncing.cancelTabs(ids),
    dispose: () => {
      syncing.cancelPending();
      unsubscribe();
      powerMonitor.removeListener("suspend", suspend);
      powerMonitor.removeListener("resume", resume);
      window.webContents.removeListener("destroyed", suspend);
      artifacts.pullRequests.setHandlers(undefined);
    },
  };
}
