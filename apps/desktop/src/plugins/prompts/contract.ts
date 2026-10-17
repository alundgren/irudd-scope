import { Schema } from "effect";
import { Revision } from "@irudd-scope/protocol";
import { PromptDocument, PromptCommand } from "@irudd-scope/protocol/prompts";

export const PromptsTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    divider: Schema.optionalKey(
      Schema.Finite.check(Schema.isBetween({ minimum: 0.4, maximum: 0.85 })),
    ),
  }),
});
export const promptsTabContract = {
  type: "prompts",
  category: "builtin" as const,
  version: 1,
  state: PromptsTabState,
};
export const promptsTabState = () => ({ version: 1, data: {} });
export type PromptWrite = Extract<PromptCommand, { action: "update-workspace" }>;
export const PromptDraft = Schema.Struct({
  revision: Revision,
  document: PromptDocument,
  pending: Schema.optionalKey(
    PromptCommand.check(
      Schema.makeFilter((command) => command.action === "update-workspace", {
        expected: "an update-workspace request",
      }),
    ),
  ),
});
export type PromptDraft = typeof PromptDraft.Type;
export type PromptDesktopCommand = Extract<
  PromptCommand,
  {
    action: "structures" | "read-workspace" | "list-items" | "read-item" | "update-workspace";
  }
>;
export type PromptResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };
