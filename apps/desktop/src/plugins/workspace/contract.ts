import { Schema } from "effect";
import { ArtifactId, ArtifactName, decode, type Artifact } from "@irudd-scope/protocol";
import { Uuid, type TabState } from "../../workspace/contract.ts";

export const WorkspaceExternalLink = Schema.Struct({
  name: ArtifactName,
  tabId: Uuid,
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
});
export type WorkspaceExternalLink = typeof WorkspaceExternalLink.Type;

export const WorkspaceFrame = Schema.Struct({
  name: ArtifactName,
  tabId: Uuid,
  channel: Uuid,
});
export type WorkspaceFrame = typeof WorkspaceFrame.Type;
export type WorkspaceLinkResult = WorkspaceFrame & { url: string; error?: string };

export const WorkspaceInterestPayload = Schema.Struct({
  tabId: Uuid,
  active: Schema.Boolean,
  refresh: Schema.optional(Schema.Boolean),
});
export type WorkspaceInterestPayload = typeof WorkspaceInterestPayload.Type;

export const WorkspaceCancelReads = Schema.Struct({
  tabId: Uuid,
  requestIds: Schema.Array(Uuid).check(Schema.isMaxLength(64)),
});
export type WorkspaceCancelReads = typeof WorkspaceCancelReads.Type;

export const WorkspaceTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({ artifactId: ArtifactId }),
});

export const workspaceTabContract = {
  type: "workspace",
  category: "builtin" as const,
  version: 1,
  state: WorkspaceTabState,
};

export const workspaceArtifactId = (state: TabState) =>
  decode(WorkspaceTabState, state).data.artifactId;

export const workspaceTabState = (artifact: Artifact): TabState => ({
  version: 1,
  data: { artifactId: artifact.id },
});
