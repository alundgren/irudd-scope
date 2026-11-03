import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { Uuid } from "../../workspace/contract.ts";
import { SketchpadDraft } from "./contract.ts";
import type { MainPluginContext } from "../main-api.ts";
import { registerSketchpadListening } from "./listening-main.ts";

function validateContent(content: string) {
  const document: unknown = JSON.parse(content);
  if (
    !document ||
    typeof document !== "object" ||
    !("type" in document) ||
    document.type !== "excalidraw" ||
    !("elements" in document) ||
    !Array.isArray(document.elements) ||
    document.elements.length === 0
  )
    throw new Error("Invalid sketchpad content.");
}

export function registerSketchpadIpc(context: MainPluginContext) {
  const { handle, artifacts } = context;
  registerSketchpadListening(context);
  handle("scope:sketchpad-draft", (input) => artifacts.sketchpadDraft(decode(Uuid, input)));
  handle("scope:save-sketchpad-draft", (input) => {
    const { id, draft } = decode(Schema.Struct({ id: Uuid, draft: SketchpadDraft }), input);
    validateContent(draft.content);
    return artifacts.saveSketchpadDraft(id, draft);
  });
  handle("scope:delete-sketchpad-draft", (input) =>
    artifacts.deleteSketchpadDraft(decode(Uuid, input)),
  );
}
