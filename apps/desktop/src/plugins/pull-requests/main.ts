import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import { PullRequestsCommand, PullRequestsRepository } from "@irudd-scope/protocol/pull-requests";
import type { MainPluginContext } from "../main-api.ts";
import { PullRequestSync } from "./sync.ts";

export function registerPullRequestsIpc({ handle, artifacts, client }: MainPluginContext) {
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
    await artifacts.pullRequests.command({
      action: "configure",
      name: input.name,
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
      syncing.cancelPending();
      artifacts.pullRequests.setHandlers(undefined);
    },
  };
}
