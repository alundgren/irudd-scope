import { hostname } from "node:os";
import { Schema } from "effect";
import { ArtifactId, Revision, decode } from "@irudd-scope/protocol";
import { Uuid } from "../../workspace/contract.ts";
import { DiagramRequest } from "./contract.ts";
import { DiagramDraft } from "./draft.ts";
import { openRouterProvider } from "./openrouter.ts";
import type { MainPluginContext } from "../main-api.ts";

export function registerDiagramIpc({
  handle,
  store,
  client,
  artifacts,
  workspace,
}: MainPluginContext) {
  let generation: AbortController | undefined;
  let generationTab: string | undefined;
  handle("scope:diagram-settings", () => store.diagramSettings());
  handle("scope:diagram-draft", (input) => artifacts.diagramDraft(decode(Uuid, input)));
  const SaveDraft = Schema.Struct({ id: Uuid, draft: DiagramDraft });
  handle("scope:save-diagram-draft", (input) => {
    const { id, draft } = decode(SaveDraft, input);
    return artifacts.saveDiagramDraft(id, draft);
  });
  handle("scope:generate-diagram", async (input) => {
    if (!store.settings().diagramGenerationEnabled)
      throw new Error("Enable diagram generation in Settings first.");
    if (generation) throw new Error("A diagram request is already running.");
    const { request, tabId } = decode(
      Schema.Struct({ request: DiagramRequest, tabId: Schema.optionalKey(Uuid) }),
      input,
    );
    generationTab = tabId;
    const active = new AbortController();
    generation = active;
    try {
      if (tabId && !(await workspace())?.tabs.some((tab) => tab.id === tabId))
        throw new Error("This tab is closed.");
      const key = await store.secret("apiKey");
      active.signal.throwIfAborted();
      if (!store.settings().diagramGenerationEnabled)
        throw new Error("Enable diagram generation in Settings first.");
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

  return {
    cancelPending: cancelDiagramGeneration,
    cancelTabs: (ids: string[]) => {
      if (generationTab && ids.includes(generationTab)) cancelDiagramGeneration();
    },
  };
}
