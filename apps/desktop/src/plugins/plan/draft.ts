import { Schema } from "effect";
import { Revision } from "@irudd-scope/protocol";
import { PlanAnnotations, PlanRecordId, MAX_PLAN_IMAGE_BYTES } from "@irudd-scope/protocol/plan";

export const PlanDraft = Schema.Struct({
  revision: Revision,
  image: Schema.String.check(Schema.isMaxLength(Math.ceil(MAX_PLAN_IMAGE_BYTES / 3) * 4)),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  text: Schema.String.check(Schema.isMaxLength(16_384)),
  page: Schema.String.check(Schema.isMaxLength(512)),
  annotations: PlanAnnotations,
  requestId: PlanRecordId,
  selectedText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  elementId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export type PlanDraft = typeof PlanDraft.Type;
