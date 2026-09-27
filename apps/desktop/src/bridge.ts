import type { Artifact } from "@irudd-scope/protocol";
import type { SettingsUpdate, SettingsView, Workspace } from "./settings.ts";
import type { DiagramRequest, DrawingResult } from "./diagram/contract.ts";
import type { DiagramDraft } from "./diagram/draft.ts";

export type Snapshot = {
  artifacts: Artifact[];
  connection: "connected" | "connecting" | "offline";
  error?: string;
};
export type ArtifactContent = { artifact: Artifact; bytes: Uint8Array };
export type ScopeBridge = {
  settings: () => Promise<SettingsView>;
  saveSettings: (input: SettingsUpdate) => Promise<SettingsView>;
  workspace: () => Promise<Workspace | null>;
  saveWorkspace: (input: Workspace) => Promise<void>;
  diagramDraft: (id: string) => Promise<DiagramDraft | null>;
  saveDiagramDraft: (id: string, draft: DiagramDraft) => Promise<void>;
  onBeforeClose: (listener: () => Promise<void>) => () => void;
  snapshot: () => Promise<Snapshot>;
  content: (id: string, revision: number) => Promise<ArtifactContent>;
  download: (id: string, revision: number) => Promise<boolean>;
  compose: (request: DiagramRequest) => Promise<DrawingResult>;
  cancelDrawing: () => Promise<void>;
  saveDiagram: (input: {
    id: string;
    title: string;
    expectedRevision: number;
    content: string;
  }) => Promise<Artifact>;
  onSnapshot: (listener: (snapshot: Snapshot) => void) => () => void;
};

declare global {
  interface Window {
    scope: ScopeBridge;
  }
}
