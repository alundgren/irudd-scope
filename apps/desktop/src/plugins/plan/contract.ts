import { Schema } from "effect";
import { ArtifactId, decode, type Artifact } from "@irudd-scope/protocol";
import type { TabState } from "../../workspace/contract.ts";

export const PlanTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    artifactId: ArtifactId,
    reviewOpen: Schema.optionalKey(Schema.Boolean),
    revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
});
export const planTabContract = { type: "plan", version: 1, state: PlanTabState };
export function planArtifactId(state: TabState): string {
  return decode(PlanTabState, state).data.artifactId;
}
export function planTabState(artifact: Artifact): TabState {
  return { version: 1, data: { artifactId: artifact.id } };
}
