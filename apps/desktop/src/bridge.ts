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

import type { PlanCommand, PlanReply, PlanEvent } from "@irudd-scope/protocol/plan";
import type { PlanDraft } from "./plugins/plan/draft.ts";
import type {
  PullRequestsCommand,
  PullRequestsReply,
  PullRequestsRepository,
  PullRequestsEvent,
} from "@irudd-scope/protocol/pull-requests";

export type ScopeBridge = {
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
  planCommand: (command: PlanCommand) => Promise<PlanReply>;
  planImage: (input: { name: string; id: string }) => Promise<Uint8Array>;
  planContent: (input: { name: string; revision: number }) => Promise<Uint8Array>;
  capturePlan: (input: {
    tabId: string;
    revision: number;
    rect: { x: number; y: number; width: number; height: number };
  }) => Promise<{ image: string; width: number; height: number }>;
  loadPlanDraft: (tabId: string) => Promise<PlanDraft | null>;
  savePlanDraft: (input: { tabId: string; draft: PlanDraft | null }) => Promise<void>;
  onPlanReconnected: (listener: () => void) => () => void;
  onPlanChanged: (listener: (event: PlanEvent) => void) => () => void;
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
