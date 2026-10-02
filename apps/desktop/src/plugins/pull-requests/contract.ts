import { Schema } from "effect";
import { ArtifactId, ArtifactName, decode, type Artifact } from "@irudd-scope/protocol";
import { Uuid, type TabState } from "../../workspace/contract.ts";

export const PullRequestsExternalLink = Schema.Struct({
  name: ArtifactName,
  tabId: Uuid,
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
});
export type PullRequestsExternalLink = typeof PullRequestsExternalLink.Type;
export const PullRequestsFrame = Schema.Struct({ name: ArtifactName, tabId: Uuid, channel: Uuid });
export type PullRequestsFrame = typeof PullRequestsFrame.Type;
export type PullRequestsLinkResult = PullRequestsFrame & { url: string; error?: string };

export const PullRequestsTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({ artifactId: ArtifactId }),
});
export const pullRequestsTabContract = {
  type: "pull-requests",
  version: 1,
  state: PullRequestsTabState,
};
export const pullRequestsArtifactId = (state: TabState) =>
  decode(PullRequestsTabState, state).data.artifactId;
export const pullRequestsTabState = (artifact: Artifact): TabState => ({
  version: 1,
  data: { artifactId: artifact.id },
});
