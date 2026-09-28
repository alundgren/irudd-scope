import { Schema } from "effect";
import { ArtifactId } from "./index.ts";
import { DiagramOperations, DiagramSnapshot, DiagramSnapshotId } from "./diagram.ts";

const requestId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
const token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const AgentHistory = Schema.Array(
  Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String.check(Schema.isMaxLength(4000)),
  }),
).check(Schema.isMaxLength(12));
export const DiagramAgentCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("wait"),
    id: ArtifactId,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  }),
  Schema.Struct({
    action: Schema.Literal("reply"),
    id: ArtifactId,
    requestId,
    token,
    snapshot: DiagramSnapshotId,
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
    operations: DiagramOperations,
  }),
  Schema.Struct({ action: Schema.Literal("release"), id: ArtifactId, requestId, token }),
]);
export type DiagramAgentCommand = typeof DiagramAgentCommand.Type;
export const DiagramAgentReply = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({
    type: Schema.Literal("request"),
    id: ArtifactId,
    requestId,
    token,
    intent: Schema.String.check(Schema.isMaxLength(16_000)),
    diagram: DiagramSnapshot,
    history: AgentHistory,
  }),
  Schema.Struct({ type: Schema.Literal("applied"), diagram: DiagramSnapshot }),
  Schema.Struct({ type: Schema.Literal("released") }),
]);
export type DiagramAgentReply = typeof DiagramAgentReply.Type;
export const DiagramAgentStatus = Schema.Struct({
  id: ArtifactId,
  phase: Schema.Literals(["disconnected", "waiting", "working"]),
  name: Schema.String,
});
export type DiagramAgentStatus = typeof DiagramAgentStatus.Type;
