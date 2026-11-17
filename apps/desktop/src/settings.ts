import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { ChatProgramChoice } from "./plugins/canvas/chat/contract.ts";

export const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;
export const SettingsUpdate = Schema.Struct({
  appearance: Schema.optionalKey(Appearance),
  voiceGenerationEnabled: Schema.optionalKey(Schema.Boolean),
  cardChatEnabled: Schema.optionalKey(Schema.Boolean),
  cardChatProgram: Schema.optionalKey(ChatProgramChoice),
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  removeApiKey: Schema.optionalKey(Schema.Boolean),
});
export type SettingsUpdate = typeof SettingsUpdate.Type;
export function decodeSettingsUpdate(value: unknown): SettingsUpdate {
  try {
    return decode(SettingsUpdate, value);
  } catch {
    throw new Error("Invalid settings. Check the key field.");
  }
}
export type SettingsView = {
  appearance: Appearance;
  voiceGenerationEnabled: boolean;
  cardChatEnabled: boolean;
  /** The program, model, reasoning and speed for card chat; null until Settings saves one. */
  cardChatProgram: ChatProgramChoice | null;
  hasApiKey: boolean | null;
  keyStorage: "keychain" | "windows" | "session";
  credentialError?: string;
};
