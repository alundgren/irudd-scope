import { contextBridge, ipcRenderer } from "electron";
import type { ScopeBridge, ArtifactLibrarySnapshot } from "./bridge.ts";
import type { AgentToolStatus, UpdateStatus } from "./installation-contract.ts";
import type { RemoteStatus } from "./remote-contract.ts";

const bridge: ScopeBridge = {
  remotes: () => ipcRenderer.invoke("scope:remotes"),
  pairRemote: (url) => ipcRenderer.invoke("scope:pair-remote", url),
  setRemoteEnabled: (id, enabled) =>
    ipcRenderer.invoke("scope:set-remote-enabled", { id, enabled }),
  removeRemote: (id) => ipcRenderer.invoke("scope:remove-remote", id),
  onRemotesChange: (listener) => {
    const receive = (_event: unknown, status: RemoteStatus[]) => listener(status);
    ipcRenderer.on("scope:remotes-changed", receive);
    return () => {
      ipcRenderer.removeListener("scope:remotes-changed", receive);
    };
  },
  updates: () => ipcRenderer.invoke("scope:updates"),
  checkForUpdates: () => ipcRenderer.invoke("scope:check-for-updates"),
  cancelUpdate: () => ipcRenderer.invoke("scope:cancel-update"),
  restartToUpdate: () => ipcRenderer.invoke("scope:restart-to-update"),
  onUpdatesChange: (listener) => {
    const receive = (_event: unknown, status: UpdateStatus) => listener(status);
    ipcRenderer.on("scope:updates-changed", receive);
    return () => {
      ipcRenderer.removeListener("scope:updates-changed", receive);
    };
  },
  agentTools: () => ipcRenderer.invoke("scope:agent-tools"),
  installCli: () => ipcRenderer.invoke("scope:install-cli"),
  removeCli: () => ipcRenderer.invoke("scope:remove-cli"),
  installSkill: () => ipcRenderer.invoke("scope:install-skill"),
  removeSkill: () => ipcRenderer.invoke("scope:remove-skill"),
  onAgentToolsChange: (listener) => {
    const receive = (_event: unknown, status: AgentToolStatus) => listener(status);
    ipcRenderer.on("scope:agent-tools-changed", receive);
    return () => {
      ipcRenderer.removeListener("scope:agent-tools-changed", receive);
    };
  },
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
