import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import { PullRequestsCommand, PullRequestsRepository } from "@irudd-scope/protocol/pull-requests";
import type { MainPluginContext } from "../main-api.ts";
import { PullRequestSync } from "./sync.ts";
import { registerPullRequestsExternalLinks } from "./external-links.ts";

export function registerPullRequestsIpc(context: MainPluginContext) {
  const { handle, artifacts, client } = context;
  const links = registerPullRequestsExternalLinks(context);
  const syncing = new PullRequestSync(artifacts.pullRequests);
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
    cancelTabs: (ids: readonly string[]) => syncing.cancelTabs(ids),
    dispose: () => {
      links.dispose();
      syncing.cancelPending();
      artifacts.pullRequests.setHandlers(undefined);
    },
  };
}
