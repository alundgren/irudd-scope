import type { Artifact } from "@irudd-scope/protocol";
import type { SettingsUpdate, SettingsView } from "./settings.ts";
import type { Workspace } from "./workspace/contract.ts";
import type { DiagramRequest, DiagramResult } from "./plugins/diagram/contract.ts";
import type { DiagramDraft } from "./plugins/diagram/draft.ts";

export type ArtifactLibrarySnapshot = {
  artifacts: Artifact[];
  connection: "connected" | "connecting" | "offline";
  error?: string;
};
export type ArtifactContent = { artifact: Artifact; bytes: Uint8Array };
import type { TabEventEnvelope } from "./plugins/events.ts";

export type ScopeBridge = {
  publishTabEvent: (event: TabEventEnvelope) => Promise<void>;
  settings: () => Promise<SettingsView>;
  saveSettings: (input: SettingsUpdate) => Promise<SettingsView>;
  workspace: () => Promise<Workspace | null>;
  saveWorkspace: (input: Workspace) => Promise<void>;
  diagramDraft: (id: string) => Promise<DiagramDraft | null>;
  saveDiagramDraft: (id: string, draft: DiagramDraft) => Promise<void>;
  onBeforeClose: (listener: () => Promise<void>) => () => void;
  artifactLibrary: () => Promise<ArtifactLibrarySnapshot>;
  content: (id: string, revision: number) => Promise<ArtifactContent>;
  download: (id: string, revision: number) => Promise<boolean>;
  generateDiagram: (request: DiagramRequest) => Promise<DiagramResult>;
  cancelDiagramGeneration: () => Promise<void>;
  saveDiagram: (input: {
    id: string;
    title: string;
    expectedRevision: number;
    content: string;
  }) => Promise<Artifact>;
  onArtifactLibraryChange: (listener: (snapshot: ArtifactLibrarySnapshot) => void) => () => void;
};

declare global {
  interface Window {
    scope: ScopeBridge;
  }
}
