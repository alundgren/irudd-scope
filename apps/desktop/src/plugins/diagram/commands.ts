import { Schema } from "effect";
import { DiagramCommand, DiagramReply } from "@irudd-scope/protocol/diagram";

export const DiagramCommandResult = Schema.Union([
  DiagramReply,
  Schema.Struct({
    type: Schema.Literal("document"),
    content: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
  }),
]);
export type DiagramCommandResult = typeof DiagramCommandResult.Type;
export const DiagramCommandRequest = Schema.Struct({
  requestId: Schema.String,
  expires: Schema.Finite,
  command: DiagramCommand,
});
export type DiagramCommandRequest = typeof DiagramCommandRequest.Type;
export const DiagramCommandResponse = Schema.Struct({
  requestId: Schema.String,
  result: Schema.optionalKey(DiagramCommandResult),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});
export type DiagramCommandResponse = typeof DiagramCommandResponse.Type;
