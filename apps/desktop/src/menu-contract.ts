import { Schema } from "effect";
import { Uuid } from "./workspace/contract.ts";

export const DiagramMenuState = Schema.NullOr(
  Schema.Struct({ tabId: Uuid, canSaveCopy: Schema.Boolean, canFit: Schema.Boolean }),
);
export type DiagramMenuState = typeof DiagramMenuState.Type;
export type DiagramMenuAction = { tabId: string; action: "save-copy" | "fit" };
