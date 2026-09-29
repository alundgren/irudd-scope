import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { DIAGRAM_MODEL, DIAGRAM_PROVIDER } from "./plugins/diagram/provider-settings.ts";

export const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;
export const SettingsUpdate = Schema.Struct({
  appearance: Schema.optionalKey(Appearance),
  diagramGenerationEnabled: Schema.optionalKey(Schema.Boolean),
  voiceGenerationEnabled: Schema.optionalKey(Schema.Boolean),
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  removeApiKey: Schema.optionalKey(Schema.Boolean),
  provider: Schema.optionalKey(Schema.Literal(DIAGRAM_PROVIDER)),
  model: Schema.optionalKey(Schema.Literal(DIAGRAM_MODEL)),
});
export type SettingsUpdate = typeof SettingsUpdate.Type;
export function decodeSettingsUpdate(value: unknown): SettingsUpdate {
  try {
    return decode(SettingsUpdate, value);
  } catch {
    throw new Error("Invalid settings. Check the provider and key fields.");
  }
}
export type SettingsView = {
  appearance: Appearance;
  diagramGenerationEnabled: boolean;
  voiceGenerationEnabled: boolean;
  provider: typeof DIAGRAM_PROVIDER;
  model: typeof DIAGRAM_MODEL;
  hasApiKey: boolean | null;
  keyStorage: "keychain" | "session";
  credentialError?: string;
};
