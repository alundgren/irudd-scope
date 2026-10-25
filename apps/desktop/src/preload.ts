import type { PromptEvent } from "@irudd-scope/protocol";
import type { RetroEvent } from "@irudd-scope/protocol";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ScopeBridge, ArtifactLibrarySnapshot } from "./bridge.ts";
import type { AgentToolStatus, UpdateStatus } from "./installation-contract.ts";
import type { RetainedTab } from "./workspace/retention.ts";
import type { RemoteStatus } from "./remote-contract.ts";
import type { MemoryStatus } from "@irudd-scope/protocol/memory";
import type { SketchpadMenuAction } from "./menu-contract.ts";

import type { PullRequestsEvent } from "@irudd-scope/protocol/pull-requests";
import type { PullRequestsDetailUpdate } from "./plugins/pull-requests/interest.ts";
import type { PullRequestsLinkResult } from "./plugins/pull-requests/contract.ts";

const retroFinishListeners = new Set<Parameters<ScopeBridge["onRetroFinishFlush"]>[0]>();
ipcRenderer.on(
  "scope:retro-finish-flush",
  (_event, request: { tabId: string; requestId: string }) => {
    void Promise.all(
      [...retroFinishListeners].map((listener) => Promise.resolve().then(() => listener(request))),
    )
      .then(
        () => ipcRenderer.invoke("scope:retro-finish-flushed", { ...request, success: true }),
        (error: unknown) =>
          ipcRenderer.invoke("scope:retro-finish-flushed", {
            ...request,
            success: false,
            error: (error instanceof Error
              ? error.message
              : "Could not save retrospective edits."
            ).slice(0, 1024),
          }),
      )
      .catch(() => {});
  },
);
function subscribe<T>(channel: string, listener: (value: T) => void) {
  const receive = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}
const bridge: ScopeBridge = {
  guestPrepare: (change) => ipcRenderer.invoke("scope:guest-prepare", change),
  guestExecute: (target, identity) =>
    ipcRenderer.invoke("scope:guest-execute", {
      target,
      operationId: identity.operationId,
      digest: identity.digest,
    }),
  guestOperationStatus: (target, identity) =>
    ipcRenderer.invoke("scope:guest-operation-status", {
      target,
      operationId: identity.operationId,
      digest: identity.digest,
    }),
  guestReconcile: (target, identity) =>
    ipcRenderer.invoke("scope:guest-reconcile", {
      target,
      operationId: identity.operationId,
      digest: identity.digest,
    }),
  onGuestRecoveryChanged: (listener) => subscribe("scope:guest-recovery-changed", listener),
  guestRecovery: (id) => ipcRenderer.invoke("scope:guest-recovery", id),
  saveGuestInput: (input) => ipcRenderer.invoke("scope:save-guest-input", input),
  discardGuestInput: (id, kind, revision) =>
    ipcRenderer.invoke("scope:discard-guest-input", { id, kind, revision }),
  guestCatalog: () => ipcRenderer.invoke("scope:guest-catalog"),
  onGuestCatalogChanged: (listener) => subscribe("scope:guest-catalog-changed", listener),
  guestContent: (id, revision) => ipcRenderer.invoke("scope:guest-content", { id, revision }),
  guestDownload: (id, revision) => ipcRenderer.invoke("scope:guest-download", { id, revision }),
  guestFolderInfo: (id) => ipcRenderer.invoke("scope:guest-folder-info", id),
  guestFolderRecovery: (id) => ipcRenderer.invoke("scope:guest-folder-recovery", id),
  guestFolderStatus: (id) => ipcRenderer.invoke("scope:guest-folder-status", id),
  guestFolderRelease: (input) => ipcRenderer.invoke("scope:guest-folder-release", input),
  guestFolderCopyOriginal: (id) => ipcRenderer.invoke("scope:guest-folder-copy-original", id),
  createFolderDirectory: (input) => ipcRenderer.invoke("scope:folder-create-directory", input),
  folderList: (input) => ipcRenderer.invoke("scope:folder-list", input),
  folderRead: (input) => ipcRenderer.invoke("scope:folder-read", input),
  folderFilter: (input) => ipcRenderer.invoke("scope:folder-filter", input),
  folderSearch: (input) => ipcRenderer.invoke("scope:folder-search", input),
  cancelFolderSearch: (tabId) => ipcRenderer.invoke("scope:folder-search-cancel", tabId),
  watchFolder: (tabId) => ipcRenderer.invoke("scope:folder-watch", tabId),
  unwatchFolder: (tabId) => ipcRenderer.invoke("scope:folder-unwatch", tabId),
  copyFolderPath: (tabId) => ipcRenderer.invoke("scope:folder-copy-path", tabId),
  onFolderEvent: (listener) => subscribe("scope:folder-event", listener),
  onFolderTabOpened: (listener) => subscribe("scope:folder-tab-opened", listener),
  prepareFolderDrop: ({ tabId, target, files }) =>
    ipcRenderer.invoke("scope:folder-drop-prepare", {
      tabId,
      target,
      // Files that did not come from this computer, such as ones built by a page, have no path.
      paths: [...files].map((file) => (file instanceof File ? webUtils.getPathForFile(file) : "")),
    }),
  startFolderDrop: (input) => ipcRenderer.invoke("scope:folder-drop-start", input),
  discardFolderDrop: (planId) => ipcRenderer.invoke("scope:folder-drop-discard", planId),
  saveFolderFile: (input) => ipcRenderer.invoke("scope:folder-save", input),
  cancelFolderTransfer: (id) => ipcRenderer.invoke("scope:folder-transfer-cancel", id),
  showFolderFileMenu: (input) => ipcRenderer.invoke("scope:folder-file-menu", input),
  onFolderTransfer: (listener) => subscribe("scope:folder-transfer", listener),
  promptCommand: (input) => ipcRenderer.invoke("scope:prompt-command", input),
  promptImage: (input) => ipcRenderer.invoke("scope:prompt-image", input),
  loadPromptDraft: (tabId) => ipcRenderer.invoke("scope:load-prompt-draft", tabId),
  savePromptDraft: (tabId, draft) =>
    ipcRenderer.invoke("scope:save-prompt-draft", { tabId, draft }),
  copyPrompt: (text) => ipcRenderer.invoke("scope:copy-prompt", text),
  exportPromptLibrary: () => ipcRenderer.invoke("scope:export-prompt-library"),
  onPromptsChanged: (listener) => {
    const receive = (_event: unknown, event: PromptEvent) => listener(event);
    ipcRenderer.on("scope:prompts-changed", receive);
    return () => ipcRenderer.removeListener("scope:prompts-changed", receive);
  },
  onPromptsReconnected: (listener) => {
    const receive = () => listener();
    ipcRenderer.on("scope:prompts-reconnected", receive);
    return () => ipcRenderer.removeListener("scope:prompts-reconnected", receive);
  },
  onRetroFinishFlush: (listener) => {
    retroFinishListeners.add(listener);
    return () => {
      retroFinishListeners.delete(listener);
    };
  },
  retroCommand: (input) => ipcRenderer.invoke("scope:retro-command", input),
  retroConfiguration: () => ipcRenderer.invoke("scope:retro-configuration"),
  saveRetroConfiguration: (input) => ipcRenderer.invoke("scope:save-retro-configuration", input),
  onRetroChanged: (listener) => {
    const receive = (_event: unknown, event: RetroEvent) => listener(event);
    ipcRenderer.on("scope:retro-changed", receive);
    return () => ipcRenderer.removeListener("scope:retro-changed", receive);
  },
  onRetroReconnected: (listener) => {
    const receive = () => listener();
    ipcRenderer.on("scope:retro-reconnected", receive);
    return () => ipcRenderer.removeListener("scope:retro-reconnected", receive);
  },
  createPullRequests: (input) => ipcRenderer.invoke("scope:create-pull-requests", input),
  pullRequestsCommand: (input) => ipcRenderer.invoke("scope:pull-requests-command", input),
  pullRequestsInterest: (input) => ipcRenderer.invoke("scope:pull-requests-interest", input),
  pullRequestsCancelReads: (input) => ipcRenderer.invoke("scope:pull-requests-cancel-reads", input),
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
  setSketchpadMenu: (state) => ipcRenderer.invoke("scope:set-sketchpad-menu", state),
  onSketchpadMenuAction: (listener) => {
    const receive = (_event: unknown, action: SketchpadMenuAction) => listener(action);
    ipcRenderer.on("scope:sketchpad-menu-action", receive);
    return () => ipcRenderer.removeListener("scope:sketchpad-menu-action", receive);
  },
  platform: process.platform,
  setFullscreen: (enabled) => ipcRenderer.invoke("scope:set-fullscreen", enabled),
  onFullscreenChange: (listener) => {
    const receive = (_event: unknown, enabled: boolean) => listener(enabled);
    ipcRenderer.on("scope:fullscreen-changed", receive);
    return () => ipcRenderer.removeListener("scope:fullscreen-changed", receive);
  },
  remotes: () => ipcRenderer.invoke("scope:remotes"),
  copyMemoryDraft: (raw) => ipcRenderer.invoke("scope:copy-memory-draft", raw),
  openMemoryLink: (url) => ipcRenderer.invoke("scope:open-memory-link", url),
  librarianRead: () => ipcRenderer.invoke("scope:librarian-read"),
  librarianHuman: (command) => ipcRenderer.invoke("scope:librarian-human", command),
  onLibrarianChange: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on("scope:librarian-changed", receive);
    return () => ipcRenderer.removeListener("scope:librarian-changed", receive);
  },
  memory: () => ipcRenderer.invoke("scope:memory"),
  setMemorySyncEnabled: (enabled) => ipcRenderer.invoke("scope:set-memory-sync-enabled", enabled),
  chooseMemoryFolder: () => ipcRenderer.invoke("scope:choose-memory-folder"),
  setMemoryEnabled: (enabled) => ipcRenderer.invoke("scope:set-memory-enabled", enabled),
  retryMemory: () => ipcRenderer.invoke("scope:retry-memory"),
  copyMemoryRequest: (kind) => ipcRenderer.invoke("scope:copy-memory-request", kind),
  onMemoryChange: (listener) => {
    const receive = (_event: unknown, status: MemoryStatus) => listener(status);
    ipcRenderer.on("scope:memory-changed", receive);
    return () => ipcRenderer.removeListener("scope:memory-changed", receive);
  },
  guestStatus: () => ipcRenderer.invoke("scope:guest-status"),
  setGuestAccess: (peerId, enabled) =>
    ipcRenderer.invoke("scope:set-guest-access", { peerId, enabled }),
  retryGuest: (peerId) => ipcRenderer.invoke("scope:retry-guest", peerId),
  guestDevices: () => ipcRenderer.invoke("scope:guest-devices"),
  createGuestInvitation: (name) => ipcRenderer.invoke("scope:create-guest-invitation", name),
  copyGuestInvitation: (id) => ipcRenderer.invoke("scope:copy-guest-invitation", id),
  inspectGuestInvitation: (name) => ipcRenderer.invoke("scope:inspect-guest-invitation", name),
  approveGuestPairing: (id) => ipcRenderer.invoke("scope:approve-guest-pairing", id),
  cancelGuestPairing: (id) => ipcRenderer.invoke("scope:cancel-guest-pairing", id),
  guestPairingStatus: () => ipcRenderer.invoke("scope:guest-pairing-status"),
  forgetGuest: (id) => ipcRenderer.invoke("scope:forget-guest", id),
  transferDevices: () => ipcRenderer.invoke("scope:transfer-devices"),
  createPairing: (name) => ipcRenderer.invoke("scope:create-pairing", name),
  copyPairingSecret: (id) => ipcRenderer.invoke("scope:copy-pairing-secret", id),
  pairScope: (input) => ipcRenderer.invoke("scope:pair-scope", input),
  forgetScope: (id) => ipcRenderer.invoke("scope:forget-scope", id),
  sendTab: (input) => ipcRenderer.invoke("scope:send-tab", input),
  transferStatus: (id) => ipcRenderer.invoke("scope:transfer-status", id),
  cancelTransfer: (id) => ipcRenderer.invoke("scope:cancel-transfer", id),
  inspectTransfer: (url) => ipcRenderer.invoke("scope:inspect-transfer", url),
  importTransfer: (url) => ipcRenderer.invoke("scope:import-transfer", url),
  onTransferLink: (listener) => {
    const receive = (_event: unknown, link: { url: string; kind: "pair" | "tab" }) =>
      listener(link);
    ipcRenderer.on("scope:transfer-link", receive);
    return () => ipcRenderer.removeListener("scope:transfer-link", receive);
  },
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
  setTabHidden: (id, hidden) => ipcRenderer.invoke("scope:set-tab-hidden", { id, hidden }),
  deferGuestTab: (id, workspace) => ipcRenderer.invoke("scope:defer-guest-tab", { id, workspace }),
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
  sketchpadDraft: (id) => ipcRenderer.invoke("scope:sketchpad-draft", id),
  saveSketchpadDraft: (id, draft) =>
    ipcRenderer.invoke("scope:save-sketchpad-draft", { id, draft }),
  deleteSketchpadDraft: (id) => ipcRenderer.invoke("scope:delete-sketchpad-draft", id),
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
  onArtifactLibraryChange: (listener) => {
    const receive = (_event: unknown, snapshot: ArtifactLibrarySnapshot) => listener(snapshot);
    ipcRenderer.on("scope:artifact-library-changed", receive);
    return () => {
      ipcRenderer.removeListener("scope:artifact-library-changed", receive);
    };
  },
};
contextBridge.exposeInMainWorld("scope", bridge);
