import { Schema } from "effect";
import { ArtifactId, decode, type Artifact } from "@irudd-scope/protocol";
import type { TabState } from "../workspace/contract.ts";

export const PublishedTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({ artifactId: ArtifactId }),
});
export function publishedArtifactId(state: TabState): string {
  return decode(PublishedTabState, state).data.artifactId;
}

export function publishedTabState(artifact: Artifact): TabState {
  return { version: 1, data: { artifactId: artifact.id } };
}
