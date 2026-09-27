import { Schema } from "effect";
import { ArtifactId } from "@irudd-scope/protocol";

export const Workspace = Schema.Struct({
  tabs: Schema.Array(ArtifactId).check(Schema.isMaxLength(100)),
  selected: Schema.NullOr(ArtifactId),
  closed: Schema.optionalKey(Schema.Array(ArtifactId)),
});
export type Workspace = typeof Workspace.Type;
