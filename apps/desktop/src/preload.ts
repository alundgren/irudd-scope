import type { DiagramAgentStatus } from "@irudd-scope/protocol/diagram-agent";
import type { DiagramCommandRequest } from "./plugins/diagram/commands.ts";
import { contextBridge, ipcRenderer } from "electron";
import type { ScopeBridge, ArtifactLibrarySnapshot } from "./bridge.ts";
import type { AgentToolStatus, UpdateStatus } from "./installation-contract.ts";
import type { RetainedTab } from "./workspace/retention.ts";
import type { RemoteStatus } from "./remote-contract.ts";
import type { DiagramMenuAction } from "./menu-contract.ts";

import type { PlanEvent } from "@irudd-scope/protocol/plan";
import type { PullRequestsEvent } from "@irudd-scope/protocol/pull-requests";
import type { PullRequestsDetailUpdate } from "./plugins/pull-requests/interest.ts";
import type { PullRequestsLinkResult } from "./plugins/pull-requests/contract.ts";

const bridge: ScopeBridge = {
  createPullRequests: (input) => ipcRenderer.invoke("scope:create-pull-requests", input),
  pullRequestsCommand: (input) => ipcRenderer.invoke("scope:pull-requests-command", input),
  pullRequestsInterest: (input) => ipcRenderer.invoke("scope:pull-requests-interest", input),
  onPullRequestsDetailUpdate: (listener) => {
    const receive = (_event: unknown, event: PullRequestsDetailUpdate) => listener(event);
    ipcRenderer.on("scope:pull-requests-detail-update", receive);
    return () => ipcRenderer.removeListener("scope:pull-requests-detail-update", receive);
  },
  openPullRequestsLink: (input) => ipcRenderer.invoke("scope:open-pull-requests-link", input),
  registerPullRequestsFrame: (input) =>
    ipcRenderer.invoke("scope:register-pull-requests-frame", input),
  unregisterPullRequestsFrame: (input) =>
    ipcRenderer.invoke("scope:unregister-pull-requests-frame", input),
  onPullRequestsLinkResult: (listener) => {
    const receive = (_event: unknown, result: PullRequestsLinkResult) => listener(result);
    ipcRenderer.on("scope:pull-requests-link-result", receive);
    return () => ipcRenderer.removeListener("scope:pull-requests-link-result", receive);
  },
  onPullRequestsReconnected: (listener) => {
    const receive = () => listener();
    ipcRenderer.on("scope:pull-requests-reconnected", receive);
    return () => ipcRenderer.removeListener("scope:pull-requests-reconnected", receive);
  },
  onPullRequestsChanged: (listener) => {
    const receive = (_event: unknown, event: PullRequestsEvent) => listener(event);
    ipcRenderer.on("scope:pull-requests-changed", receive);
    return () => ipcRenderer.removeListener("scope:pull-requests-changed", receive);
  },
  createPlan: (input) => ipcRenderer.invoke("scope:create-plan", input),
  planCommand: (input) => ipcRenderer.invoke("scope:plan-command", input),
  planImage: (input) => ipcRenderer.invoke("scope:plan-image", input),
  planContent: (input) => ipcRenderer.invoke("scope:plan-content", input),
  capturePlan: (input) => ipcRenderer.invoke("scope:capture-plan", input),
  loadPlanDraft: (tabId) => ipcRenderer.invoke("scope:load-plan-draft", tabId),
  savePlanDraft: (input) => ipcRenderer.invoke("scope:save-plan-draft", input),
  onPlanReconnected: (listener) => {
    const receive = () => listener();
    ipcRenderer.on("scope:plan-reconnected", receive);
    return () => ipcRenderer.removeListener("scope:plan-reconnected", receive);
  },
  onPlanChanged: (listener) => {
    const receive = (_event: unknown, event: PlanEvent) => listener(event);
    ipcRenderer.on("scope:plan-changed", receive);
    return () => ipcRenderer.removeListener("scope:plan-changed", receive);
  },
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
  setDiagramMenu: (state) => ipcRenderer.invoke("scope:set-diagram-menu", state),
  onDiagramMenuAction: (listener) => {
    const receive = (_event: unknown, action: DiagramMenuAction) => listener(action);
    ipcRenderer.on("scope:diagram-menu-action", receive);
    return () => ipcRenderer.removeListener("scope:diagram-menu-action", receive);
  },
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
  platform: process.platform,
  setFullscreen: (enabled) => ipcRenderer.invoke("scope:set-fullscreen", enabled),
  onFullscreenChange: (listener) => {
    const receive = (_event: unknown, enabled: boolean) => listener(enabled);
    ipcRenderer.on("scope:fullscreen-changed", receive);
    return () => ipcRenderer.removeListener("scope:fullscreen-changed", receive);
  },
  remotes: () => ipcRenderer.invoke("scope:remotes"),
  pairRemote: (url) => ipcRenderer.invoke("scope:pair-remote", url),
  setRemoteEnabled: (id, enabled) =>
    ipcRenderer.invoke("scope:set-remote-enabled", { id, enabled }),
  removeRemote: (id) => ipcRenderer.invoke("scope:remove-remote", id),
  retryRemoteUpdate: (id) => ipcRenderer.invoke("scope:retry-remote-update", id),
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
  providerSettings: () => ipcRenderer.invoke("scope:provider-settings"),
  saveSettings: (input) => ipcRenderer.invoke("scope:save-settings", input),
  openTab: (tab, artifactRevision) =>
    ipcRenderer.invoke("scope:open-tab", { tab, artifactRevision }),
  retainedTabs: () => ipcRenderer.invoke("scope:retained-tabs"),
  onRetentionChanged: (listener) => {
    const receive = (_event: unknown, tabs: RetainedTab[]) => listener(tabs);
    ipcRenderer.on("scope:retention-changed", receive);
    return () => ipcRenderer.removeListener("scope:retention-changed", receive);
  },
  setTabPermanent: (id, permanent) =>
    ipcRenderer.invoke("scope:set-tab-permanent", { id, permanent }),
  restoreTab: (id) => ipcRenderer.invoke("scope:restore-tab", id),
  emptyTrash: (entries) => ipcRenderer.invoke("scope:empty-trash", entries),
  reportVisibleTabs: (ids) => ipcRenderer.invoke("scope:visible-tabs", ids),
  checkTabRetention: (ids) => ipcRenderer.invoke("scope:check-tab-retention", ids),
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
  diagramEvent: (event) => ipcRenderer.invoke("scope:diagram-event", event),
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
