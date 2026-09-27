import { contextBridge, ipcRenderer } from "electron";
import type { ScopeBridge, Snapshot } from "./bridge.ts";

const bridge: ScopeBridge = {
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
  snapshot: () => ipcRenderer.invoke("scope:snapshot"),
  content: (id, revision) => ipcRenderer.invoke("scope:content", { id, revision }),
  download: (id, revision) => ipcRenderer.invoke("scope:download", { id, revision }),
  compose: (request) => ipcRenderer.invoke("scope:compose", request),
  cancelDrawing: () => ipcRenderer.invoke("scope:cancel-drawing"),
  saveDiagram: (input) => ipcRenderer.invoke("scope:save-diagram", input),
  onSnapshot: (listener) => {
    const receive = (_event: unknown, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on("scope:snapshot-changed", receive);
    return () => {
      ipcRenderer.removeListener("scope:snapshot-changed", receive);
    };
  },
};
contextBridge.exposeInMainWorld("scope", bridge);
