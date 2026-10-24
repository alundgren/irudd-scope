import { Schema } from "effect";
import { BlobId, Revision } from "@irudd-scope/protocol";
import { GuestOperation, GuestOutcome } from "@irudd-scope/protocol/guest-operation";
import { TransferId } from "@irudd-scope/protocol/transfer";

export const GuestRecoveryKey = Schema.Struct({
  guestId: TransferId,
  ownerDeviceId: TransferId,
  sourceTabId: TransferId,
  revision: Revision,
  sourceVersion: Schema.optionalKey(Revision),
  blob: Schema.optionalKey(BlobId),
});
export type GuestRecoveryKey = typeof GuestRecoveryKey.Type;
export const recoveryInputTypes = [
  "text",
  "search",
  "url",
  "number",
  "range",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "checkbox",
  "radio",
];
export const sensitiveField =
  /password|passwd|secret|token|credential|credit|card|cvc|cvv|ssn|social.?security|one.?time|otp|email|phone|telephone/i;
export const GuestField = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  tag: Schema.Literals(["input", "textarea", "select"]),
  type: Schema.String.check(Schema.isMaxLength(32)),
  value: Schema.String.check(Schema.isMaxLength(8192)),
  checked: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(Schema.isMaxLength(64)),
  ),
}).check(
  Schema.makeFilter(
    (field) =>
      !sensitiveField.test(field.key) &&
      (field.tag === "input"
        ? recoveryInputTypes.includes(field.type)
        : field.tag === "textarea"
          ? field.type === "textarea"
          : ["select-one", "select-multiple"].includes(field.type)),
    { expected: "supported non-sensitive field metadata" },
  ),
);
export type GuestField = typeof GuestField.Type;
export const GuestInput = Schema.Struct({
  ...GuestRecoveryKey.fields,
  kind: Schema.Literals(["html", "action"]),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
  fields: Schema.Array(GuestField).check(Schema.isMaxLength(64)),
});
export type GuestInput = typeof GuestInput.Type;
export const GuestPending = Schema.Struct({
  guestId: TransferId,
  operation: GuestOperation,
  outcome: GuestOutcome,
  dispatched: Schema.Boolean,
});
export type GuestPending = typeof GuestPending.Type;
export type GuestRecovery = { inputs: GuestInput[]; pending?: GuestPending };
