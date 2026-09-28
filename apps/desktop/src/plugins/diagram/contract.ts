import { PublishedTabState } from "../../library/tab-state.ts";
import { Schema } from "effect";
import {
  DiagramObjectId,
  DiagramOperations,
  ReadOnlyDiagramObject,
  SceneSchema,
} from "@irudd-scope/protocol/diagram";
export {
  DiagramOperation,
  SceneSchema,
  parseScene,
  emptyScene,
} from "@irudd-scope/protocol/diagram";
export type { SemanticScene, SceneNode } from "@irudd-scope/protocol/diagram";

export const DiagramMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(4000)),
});
export const DiagramResponse = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(2000)),
  operations: DiagramOperations,
});
export const DiagramRequest = Schema.Struct({
  intent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
  scene: SceneSchema,
  selectedIds: Schema.optionalKey(Schema.Array(DiagramObjectId).check(Schema.isMaxLength(1000))),
  readOnly: Schema.optionalKey(Schema.Array(ReadOnlyDiagramObject).check(Schema.isMaxLength(1000))),
  omitted: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  history: Schema.optionalKey(Schema.Array(DiagramMessage).check(Schema.isMaxLength(12))),
});
export type DiagramRequest = typeof DiagramRequest.Type;
export type DiagramResult = typeof DiagramResponse.Type & {
  metrics: {
    model: string;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  };
};
export interface DiagramProvider {
  generateDiagram: (request: DiagramRequest, signal: AbortSignal) => Promise<DiagramResult>;
}

export const diagramTabContract = { type: "diagram", version: 1, state: PublishedTabState };
