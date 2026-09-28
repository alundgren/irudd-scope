import { Schema } from "effect";
import { DiagramCommand, DiagramReply } from "@irudd-scope/protocol/diagram";
import { DiagramSyncCommand, DiagramSyncReply } from "@irudd-scope/protocol/diagram-sync";
import { ArtifactId } from "@irudd-scope/protocol";

export const HostedDiagramCommand = Schema.Union([
  DiagramCommand,
  Schema.Struct({ action: Schema.Literal("sync"), id: ArtifactId, request: DiagramSyncCommand }),
]);
export type HostedDiagramCommand = typeof HostedDiagramCommand.Type;

export const DiagramCommandResult = Schema.Union([
  DiagramReply,
  DiagramSyncReply,
  Schema.Struct({
    type: Schema.Literal("document"),
    content: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
  }),
]);
export type DiagramCommandResult = typeof DiagramCommandResult.Type;
export const DiagramCommandRequest = Schema.Struct({
  requestId: Schema.String,
  expires: Schema.Finite,
  command: HostedDiagramCommand,
});
export type DiagramCommandRequest = typeof DiagramCommandRequest.Type;
export const DiagramCommandResponse = Schema.Struct({
  requestId: Schema.String,
  result: Schema.optionalKey(DiagramCommandResult),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});
export type DiagramCommandResponse = typeof DiagramCommandResponse.Type;
