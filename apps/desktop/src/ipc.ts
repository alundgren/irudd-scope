import { dialog, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { Schema } from "effect";
import { ArtifactId, Revision, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { DesktopStore } from "./desktop-store.ts";
import type { ArtifactLibrary } from "./artifacts/library.ts";
import { decodeSettingsUpdate } from "./settings.ts";
import { DiagramRequest } from "./diagram/contract.ts";
import { DiagramDraft } from "./diagram/draft.ts";
import { openRouterProvider } from "./diagram/openrouter.ts";

export function registerDesktopIpc({
  window,
  store,
  library,
  client,
  onCloseReady,
}: {
  window: BrowserWindow;
  store: DesktopStore;
  library: ArtifactLibrary;
  client: ScopeClient;
  onCloseReady: (saved: boolean) => void;
}) {
  let generation: AbortController | undefined;

  function handle(channel: string, action: (input: unknown) => unknown) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("scope://app/")
      )
        throw new Error("Untrusted IPC caller.");
      try {
        return await action(input);
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "Scope could not complete the operation.",
        );
      }
    });
  }

  handle("scope:settings", () => store.settings());
  handle("scope:workspace", () => store.workspace());
  handle("scope:save-workspace", (input) => store.saveWorkspace(input));
  handle("scope:diagram-draft", (input) => store.diagramDraft(input));
  const SaveDraft = Schema.Struct({ id: ArtifactId, draft: DiagramDraft });
  handle("scope:save-diagram-draft", (input) => {
    const { id, draft } = decode(SaveDraft, input);
    return store.saveDiagramDraft(id, draft);
  });
  handle("scope:close-ready", (input) => onCloseReady(decode(Schema.Boolean, input)));
  handle("scope:save-settings", async (input) => {
    const result = await store.saveSettings(decodeSettingsUpdate(input));
    nativeTheme.themeSource = result.appearance;
    return result;
  });
  handle("scope:artifact-library", () => library.snapshot());
  handle("scope:generate-diagram", async (input) => {
    if (generation) throw new Error("A diagram request is already running.");
    const request = decode(DiagramRequest, input);
    const active = new AbortController();
    generation = active;
    try {
      const key = await store.secret("apiKey");
      if (!key) throw new Error("Add an OpenRouter key in Settings first.");
      return await openRouterProvider(key).generateDiagram(request, active.signal);
    } finally {
      if (generation === active) generation = undefined;
    }
  });
  function cancelDiagramGeneration(): void {
    generation?.abort();
  }
  handle("scope:cancel-diagram-generation", cancelDiagramGeneration);

  const SaveDiagram = Schema.Struct({
    id: ArtifactId,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    expectedRevision: Revision,
    content: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
  });
  handle("scope:save-diagram", async (value) => {
    const input = decode(SaveDiagram, value);
    const document: unknown = JSON.parse(input.content);
    if (
      !document ||
      typeof document !== "object" ||
      !("type" in document) ||
      document.type !== "excalidraw" ||
      !("elements" in document) ||
      !Array.isArray(document.elements) ||
      document.elements.length > 10_000
    )
      throw new Error("Invalid Excalidraw document.");
    const previous = input.expectedRevision ? await client.get(input.id) : undefined;
    return client.publish(
      input.id,
      {
        title: input.title,
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: `${input.id}.excalidraw`,
        expectedRevision: input.expectedRevision,
        source: previous?.source ?? { host: hostname(), agent: "scope" },
      },
      new TextEncoder().encode(input.content),
    );
  });

  const ContentRequest = Schema.Struct({ id: ArtifactId, revision: Revision });
  async function content(input: unknown) {
    const { id, revision } = decode(ContentRequest, input);
    return library.content(id, revision);
  }
  handle("scope:content", content);
  handle("scope:download", async (input) => {
    const item = await content(input);
    const selection = await dialog.showSaveDialog(window, {
      title: "Save artifact",
      defaultPath: item.artifact.fileName,
    });
    if (selection.canceled || !selection.filePath) return false;
    await writeFile(selection.filePath, item.bytes);
    return true;
  });

  return { cancelDiagramGeneration };
}
