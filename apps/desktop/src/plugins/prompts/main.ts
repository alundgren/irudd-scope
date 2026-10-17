import { clipboard, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { BlobId, ScopeError, decode } from "@irudd-scope/protocol";
import { PromptCommand, PromptItemId, type PromptReply } from "@irudd-scope/protocol/prompts";
import { Uuid } from "../../workspace/contract.ts";
import { PromptDraft, promptsTabState, type PromptResult } from "./contract.ts";
import type { MainPluginContext } from "../main-api.ts";
import type { DesktopLifecycle } from "../../lifecycle.ts";

export async function initializePromptsTab(lifecycle: DesktopLifecycle) {
  const workspace = await lifecycle.workspace();
  if (workspace.tabs.some((tab) => tab.type === "prompts")) return;
  const tab = await lifecycle.openTab({
    id: crypto.randomUUID(),
    groupId: workspace.groups[0].id,
    type: "prompts",
    title: "Prompts",
    state: promptsTabState(),
  });
  if (tab)
    await lifecycle.desktop.saveLayout({
      groups: workspace.groups,
      selected: workspace.selected ?? tab.id,
    });
}

export function registerPromptsIpc({ handle, artifacts, window }: MainPluginContext) {
  handle("scope:prompt-command", async (input): Promise<PromptResult<PromptReply>> => {
    const command = decode(PromptCommand, input);
    if (
      !["structures", "read-workspace", "list-items", "read-item", "update-workspace"].includes(
        command.action,
      )
    )
      throw new Error("Curate the prompt library through the CLI.");
    try {
      return { ok: true, value: await artifacts.prompts.command(command) };
    } catch (error) {
      return {
        ok: false,
        status: error instanceof ScopeError ? error.status : 500,
        message: error instanceof Error ? error.message : "Could not save the prompt. Retry.",
      };
    }
  });
  handle("scope:prompt-image", (input) => {
    const { itemId, imageId } = decode(
      Schema.Struct({ itemId: PromptItemId, imageId: BlobId }),
      input,
    );
    return artifacts.prompts.image(itemId, imageId);
  });
  handle("scope:load-prompt-draft", (input) => artifacts.promptDraft(decode(Uuid, input)));
  handle("scope:save-prompt-draft", (input) => {
    const { tabId, draft } = decode(
      Schema.Struct({ tabId: Uuid, draft: Schema.NullOr(PromptDraft) }),
      input,
    );
    return artifacts.savePromptDraft(tabId, draft);
  });
  handle("scope:copy-prompt", (input) =>
    clipboard.writeText(decode(Schema.String.check(Schema.isMaxLength(120_000)), input)),
  );
  handle("scope:export-prompt-library", async () => {
    const selection = await dialog.showSaveDialog(window, {
      title: "Export prompt library",
      defaultPath: "prompt-library.zip",
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (selection.canceled || !selection.filePath) return false;
    const bytes = await artifacts.prompts.exportLibrary();
    await writeFile(selection.filePath, bytes);
    return true;
  });
}
