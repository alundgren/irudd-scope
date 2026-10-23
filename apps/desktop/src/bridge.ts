import type { PromptEvent } from "@irudd-scope/protocol";
import type { PromptReply, PromptImage } from "@irudd-scope/protocol/prompts";
import type {
  PromptDesktopCommand,
  PromptDraft,
  PromptResult,
} from "./plugins/prompts/contract.ts";
import type { RetroCommand, RetroReply, RetroConfiguration } from "@irudd-scope/protocol/retro";
import type { RetroEvent } from "@irudd-scope/protocol";
import type { Artifact } from "@irudd-scope/protocol";
import type { SettingsUpdate, SettingsView } from "./settings.ts";
import type { RetainedTab, TrashEntry } from "./workspace/retention.ts";
import type { Tab, Workspace } from "./workspace/contract.ts";
import type { SketchpadDraft } from "./plugins/sketchpad/contract.ts";
import type { AgentToolStatus, SigningCertificate, UpdateStatus } from "./installation-contract.ts";
import type { RemoteStatus } from "./remote-contract.ts";
import type { MemoryStatus } from "@irudd-scope/protocol/memory";
import type { LibrarianView, LibrarianHumanCommand } from "@irudd-scope/protocol/librarian";
import type {
  TransferDevices,
  TransferImport,
  TransferPreview,
  TransferStatus,
} from "./transfer/contract.ts";
import type { SketchpadMenuAction, SketchpadMenuState } from "./menu-contract.ts";
import type {
  PullRequestsInterest,
  PullRequestsCancelReads,
  PullRequestsDetailUpdate,
} from "./plugins/pull-requests/interest.ts";
import type {
  PullRequestsExternalLink,
  PullRequestsFrame,
  PullRequestsLinkResult,
} from "./plugins/pull-requests/contract.ts";

export type ArtifactLibrarySnapshot = {
  artifacts: Artifact[];
  connection: "connected" | "connecting" | "offline";
  error?: string;
};
export type ArtifactContent = { artifact: Artifact; bytes: Uint8Array };
import type { TabEventEnvelope } from "./plugins/events.ts";
import type {
  FolderFilterResult,
  FolderListResult,
  FolderSearchResult,
  FolderTabOpened,
  FolderViewEvent,
} from "./plugins/folder/contract.ts";

import type {
  PullRequestsCommand,
  PullRequestsReply,
  PullRequestsRepository,
  PullRequestsEvent,
} from "@irudd-scope/protocol/pull-requests";

export type ScopeBridge = {
  folderList: (input: {
    tabId: string;
    path: string;
    showIgnored: boolean;
  }) => Promise<FolderListResult>;
  folderRead: (input: {
    tabId: string;
    path: string;
    start: number;
    end: number;
  }) => Promise<{ size: number; modifiedAt: number; start: number; bytes: Uint8Array }>;
  /** Matches file paths against the filter text; empty text starts the path list. */
  folderFilter: (input: {
    tabId: string;
    text: string;
    showIgnored: boolean;
  }) => Promise<FolderFilterResult>;
  /** Searches file contents on the folder's machine. A new search cancels the tab's last one. */
  folderSearch: (input: {
    tabId: string;
    query: string;
    showIgnored: boolean;
  }) => Promise<FolderSearchResult>;
  cancelFolderSearch: (tabId: string) => Promise<void>;
  watchFolder: (tabId: string) => Promise<void>;
  unwatchFolder: (tabId: string) => Promise<void>;
  copyFolderPath: (tabId: string) => Promise<void>;
  onFolderEvent: (listener: (event: FolderViewEvent) => void) => () => void;
  onFolderTabOpened: (listener: (opened: FolderTabOpened) => void) => () => void;
  promptCommand: (input: PromptDesktopCommand) => Promise<PromptResult<PromptReply>>;
  promptImage: (input: {
    itemId: string;
    imageId: string;
  }) => Promise<{ image: PromptImage; bytes: Uint8Array }>;
  loadPromptDraft: (tabId: string) => Promise<PromptDraft | null>;
  savePromptDraft: (tabId: string, draft: PromptDraft | null) => Promise<void>;
  copyPrompt: (text: string) => Promise<void>;
  exportPromptLibrary: () => Promise<boolean>;
  onPromptsChanged: (listener: (event: PromptEvent) => void) => () => void;
  onPromptsReconnected: (listener: () => void) => () => void;
  onRetroFinishFlush: (
    listener: (request: { tabId: string; requestId: string }) => Promise<void>,
  ) => () => void;
  retroCommand: (command: RetroCommand) => Promise<RetroReply>;
  retroConfiguration: () => Promise<RetroConfiguration>;
  saveRetroConfiguration: (
    input: Omit<Extract<RetroCommand, { action: "configure" }>, "action">,
  ) => Promise<RetroConfiguration>;
  onRetroChanged: (listener: (event: RetroEvent) => void) => () => void;
  onRetroReconnected: (listener: () => void) => () => void;
  createPullRequests: (input: {
    name: string;
    title: string;
    html: string;
    repository: PullRequestsRepository;
  }) => Promise<Artifact>;
  pullRequestsCommand: (command: PullRequestsCommand) => Promise<PullRequestsReply>;
  pullRequestsInterest: (input: PullRequestsInterest) => Promise<void>;
  pullRequestsCancelReads: (input: PullRequestsCancelReads) => Promise<void>;
  onPullRequestsDetailUpdate: (listener: (event: PullRequestsDetailUpdate) => void) => () => void;
  openPullRequestsLink: (input: PullRequestsExternalLink) => Promise<void>;
  registerPullRequestsFrame: (input: PullRequestsFrame) => Promise<void>;
  unregisterPullRequestsFrame: (input: PullRequestsFrame) => Promise<void>;
  onPullRequestsLinkResult: (listener: (result: PullRequestsLinkResult) => void) => () => void;
  onPullRequestsReconnected: (listener: () => void) => () => void;
  onPullRequestsChanged: (listener: (event: PullRequestsEvent) => void) => () => void;
  createPlan: (input: { name: string; title: string; html: string }) => Promise<Artifact>;
  setSketchpadMenu: (state: SketchpadMenuState) => Promise<void>;
  onSketchpadMenuAction: (listener: (action: SketchpadMenuAction) => void) => () => void;
  platform: string;
  setFullscreen: (enabled: boolean) => Promise<void>;
  onFullscreenChange: (listener: (enabled: boolean) => void) => () => void;
  remotes: () => Promise<RemoteStatus[]>;
  copyMemoryDraft: (raw: string) => Promise<void>;
  openMemoryLink: (url: string) => Promise<void>;
  librarianRead: () => Promise<LibrarianView>;
  librarianHuman: (command: LibrarianHumanCommand) => Promise<LibrarianView>;
  onLibrarianChange: (listener: (state: LibrarianView) => void) => () => void;
  memory: () => Promise<MemoryStatus>;
  setMemorySyncEnabled: (enabled: boolean) => Promise<MemoryStatus>;
  chooseMemoryFolder: () => Promise<MemoryStatus>;
  setMemoryEnabled: (enabled: boolean) => Promise<MemoryStatus>;
  retryMemory: () => Promise<MemoryStatus>;
  copyMemoryRequest: (kind: "create" | "conflicts") => Promise<void>;
  onMemoryChange: (listener: (status: MemoryStatus) => void) => () => void;
  transferDevices: () => Promise<TransferDevices>;
  createPairing: (name: string) => Promise<TransferStatus>;
  copyPairingSecret: (id: string) => Promise<void>;
  pairScope: (input: { url: string; secret: string; name: string }) => Promise<void>;
  forgetScope: (id: string) => Promise<void>;
  sendTab: (input: { tabId: string; peerId: string }) => Promise<TransferStatus>;
  transferStatus: (id: string) => Promise<TransferStatus>;
  cancelTransfer: (id: string) => Promise<void>;
  inspectTransfer: (url: string) => Promise<TransferPreview>;
  importTransfer: (url: string) => Promise<TransferImport>;
  onTransferLink: (listener: (link: { url: string; kind: "pair" | "tab" }) => void) => () => void;
  pairRemote: (url: string) => Promise<void>;
  setRemoteEnabled: (id: string, enabled: boolean) => Promise<void>;
  removeRemote: (id: string) => Promise<void>;
  retryRemoteUpdate: (id: string) => Promise<void>;
  onRemotesChange: (listener: (status: RemoteStatus[]) => void) => () => void;
  updates: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<void>;
  cancelUpdate: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  signingCertificate: () => Promise<SigningCertificate | undefined>;
  connectSigningCertificate: (name: string) => Promise<void>;
  disconnectSigningCertificate: () => Promise<void>;
  openKeychainAccess: () => Promise<void>;
  onUpdatesChange: (listener: (status: UpdateStatus) => void) => () => void;
  agentTools: () => Promise<AgentToolStatus>;
  installCli: () => Promise<AgentToolStatus>;
  removeCli: () => Promise<AgentToolStatus>;
  installSkill: () => Promise<AgentToolStatus>;
  removeSkill: () => Promise<AgentToolStatus>;
  onAgentToolsChange: (listener: (status: AgentToolStatus) => void) => () => void;
  publishTabEvent: (event: TabEventEnvelope) => Promise<void>;
  settings: () => Promise<SettingsView>;
  providerSettings: () => Promise<SettingsView>;
  saveSettings: (input: SettingsUpdate) => Promise<SettingsView>;
  openTab: (tab: Tab, artifactRevision?: number) => Promise<Tab | null>;
  retainedTabs: () => Promise<RetainedTab[]>;
  onRetentionChanged: (listener: (tabs: RetainedTab[]) => void) => () => void;
  setTabPermanent: (id: string, permanent: boolean) => Promise<void>;
  /** Closes an open tab to the drawer, or reopens it, without saving the whole workspace. */
  setTabHidden: (id: string, hidden: boolean) => Promise<void>;
  restoreTab: (id: string) => Promise<Tab>;
  emptyTrash: (entries: readonly TrashEntry[]) => Promise<void>;
  reportVisibleTabs: (ids: readonly string[]) => Promise<void>;
  checkTabRetention: (ids: readonly string[]) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  onTabsClosed: (listener: (ids: string[]) => void) => () => void;
  workspace: () => Promise<Workspace | null>;
  saveWorkspace: (input: Workspace) => Promise<void>;
  sketchpadDraft: (id: string) => Promise<SketchpadDraft | null>;
  saveSketchpadDraft: (id: string, draft: SketchpadDraft) => Promise<void>;
  deleteSketchpadDraft: (id: string) => Promise<void>;
  onBeforeClose: (listener: () => Promise<void>) => () => void;
  artifactLibrary: () => Promise<ArtifactLibrarySnapshot>;
  content: (id: string, revision: number) => Promise<ArtifactContent>;
  download: (id: string, revision: number) => Promise<boolean>;
  onArtifactLibraryChange: (listener: (snapshot: ArtifactLibrarySnapshot) => void) => () => void;
};

declare global {
  interface Window {
    scope: ScopeBridge;
  }
}
