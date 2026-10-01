import { Schema } from "effect";
import { ArtifactId, decode, type Artifact } from "@irudd-scope/protocol";
import type { TabState } from "../../workspace/contract.ts";

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
