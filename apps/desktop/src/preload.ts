import { contextBridge, ipcRenderer } from "electron";
import type { ScopeBridge, ArtifactLibrarySnapshot } from "./bridge.ts";

const bridge: ScopeBridge = {
  publishTabEvent: (event) => ipcRenderer.invoke("scope:publish-tab-event", event),
  settings: () => ipcRenderer.invoke("scope:settings"),
  saveSettings: (input) => ipcRenderer.invoke("scope:save-settings", input),
  workspace: () => ipcRenderer.invoke("scope:workspace"),
  saveWorkspace: (input) => ipcRenderer.invoke("scope:save-workspace", input),
  diagramDraft: (id) => ipcRenderer.invoke("scope:diagram-draft", id),
  saveDiagramDraft: (id, draft) => ipcRenderer.invoke("scope:save-diagram-draft", { id, draft }),
  onBeforeClose: (listener) => {
    const flush = () => {
      void listener().then(
        () => ipcRenderer.invoke("scope:close-ready", true),
        () => ipcRenderer.invoke("scope:close-ready", false),
      );
    };
    ipcRenderer.on("scope:before-close", flush);
    return () => {
      ipcRenderer.removeListener("scope:before-close", flush);
    };
  },
  artifactLibrary: () => ipcRenderer.invoke("scope:artifact-library"),
  content: (id, revision) => ipcRenderer.invoke("scope:content", { id, revision }),
  download: (id, revision) => ipcRenderer.invoke("scope:download", { id, revision }),
  generateDiagram: (request) => ipcRenderer.invoke("scope:generate-diagram", request),
  cancelDiagramGeneration: () => ipcRenderer.invoke("scope:cancel-diagram-generation"),
  saveDiagram: (input) => ipcRenderer.invoke("scope:save-diagram", input),
  onArtifactLibraryChange: (listener) => {
    const receive = (_event: unknown, snapshot: ArtifactLibrarySnapshot) => listener(snapshot);
    ipcRenderer.on("scope:artifact-library-changed", receive);
    return () => {
      ipcRenderer.removeListener("scope:artifact-library-changed", receive);
    };
  },
};
contextBridge.exposeInMainWorld("scope", bridge);
