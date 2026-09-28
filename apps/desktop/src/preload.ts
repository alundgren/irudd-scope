import type { DiagramAgentStatus } from "@irudd-scope/protocol/diagram-agent";
import type { DiagramCommandRequest } from "./plugins/diagram/commands.ts";
import { contextBridge, ipcRenderer } from "electron";
import type { ScopeBridge, ArtifactLibrarySnapshot } from "./bridge.ts";
import type { AgentToolStatus, UpdateStatus } from "./installation-contract.ts";
import type { RemoteStatus } from "./remote-contract.ts";

const bridge: ScopeBridge = {
  diagramAgentStatus: (id) => ipcRenderer.invoke("scope:diagram-agent-status", id),
  onDiagramAgentStatus: (listener) => {
    const receive = (_event: unknown, status: DiagramAgentStatus) => listener(status);
    ipcRenderer.on("scope:diagram-agent-status", receive);
    return () => {
      ipcRenderer.removeListener("scope:diagram-agent-status", receive);
    };
  },
  requestDiagramAgent: (request) => ipcRenderer.invoke("scope:request-diagram-agent", request),
  cancelDiagramAgent: (id) => ipcRenderer.invoke("scope:cancel-diagram-agent", id),
  onDiagramCommand: (listener) => {
    const receive = (_event: unknown, input: DiagramCommandRequest) => listener(input);
    ipcRenderer.on("scope:diagram-command", receive);
    return () => {
      ipcRenderer.removeListener("scope:diagram-command", receive);
    };
  },
  onDiagramCommandCancel: (listener) => {
    const receive = (_event: unknown, id: string) => listener(id);
    ipcRenderer.on("scope:diagram-command-cancel", receive);
    return () => {
      ipcRenderer.removeListener("scope:diagram-command-cancel", receive);
    };
  },
  diagramCommandResult: (response) => ipcRenderer.invoke("scope:diagram-command-result", response),
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
  signingCertificate: () => ipcRenderer.invoke("scope:signing-certificate"),
  connectSigningCertificate: (name) =>
    ipcRenderer.invoke("scope:connect-signing-certificate", name),
  disconnectSigningCertificate: () => ipcRenderer.invoke("scope:disconnect-signing-certificate"),
  openKeychainAccess: () => ipcRenderer.invoke("scope:open-keychain-access"),
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
  diagramSettings: () => ipcRenderer.invoke("scope:diagram-settings"),
  saveSettings: (input) => ipcRenderer.invoke("scope:save-settings", input),
  openTab: (tab, artifactRevision) =>
    ipcRenderer.invoke("scope:open-tab", { tab, artifactRevision }),
  closeTab: (id) => ipcRenderer.invoke("scope:close-tab", id),
  onTabsClosed: (listener) => {
    const receive = (_event: unknown, ids: string[]) => listener(ids);
    ipcRenderer.on("scope:tabs-closed", receive);
    return () => {
      ipcRenderer.removeListener("scope:tabs-closed", receive);
    };
  },
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
  generateDiagram: (request, tabId) =>
    ipcRenderer.invoke("scope:generate-diagram", { request, ...(tabId ? { tabId } : {}) }),
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
