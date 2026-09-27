import { Schema } from "effect";
import { Revision } from "@irudd-scope/protocol";
import { Uuid } from "../workspace/contract.ts";

const Resource = Schema.Struct({
  kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export const TabEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("resource.selected"), resource: Resource }),
  Schema.Struct({ type: Schema.Literal("resource.saved"), resource: Resource, revision: Revision }),
]);
export type TabEvent = typeof TabEvent.Type;
export const TabEventEnvelope = Schema.Struct({
  tabId: Uuid,
  groupId: Uuid,
  event: TabEvent,
});
export type TabEventEnvelope = typeof TabEventEnvelope.Type;
export type TabEvents = {
  emit: (event: TabEvent) => void;
  on: <T extends TabEvent["type"]>(
    type: T,
    listener: (event: Extract<TabEvent, { type: T }>) => void | Promise<void>,
  ) => () => void;
};
