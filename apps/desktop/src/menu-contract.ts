import { Schema } from "effect";
import { Uuid } from "./workspace/contract.ts";

export const SketchpadMenuState = Schema.NullOr(
  Schema.Struct({ tabId: Uuid, canFit: Schema.Boolean }),
);
export type SketchpadMenuState = typeof SketchpadMenuState.Type;
export type SketchpadMenuAction = { tabId: string; action: "fit" };
