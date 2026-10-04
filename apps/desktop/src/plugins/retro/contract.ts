import { Schema } from "effect";
import { ArtifactId, decode, type Artifact } from "@irudd-scope/protocol";
import type { TabState } from "../../workspace/contract.ts";

export const RetroTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({ artifactId: ArtifactId }),
});
export const retroTabContract = { type: "retro", version: 1, state: RetroTabState };
export function retroArtifactId(state: TabState): string {
  return decode(RetroTabState, state).data.artifactId;
}
export function retroTabState(artifact: Artifact): TabState {
  return { version: 1, data: { artifactId: artifact.id } };
}
