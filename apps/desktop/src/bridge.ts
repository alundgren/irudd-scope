import type { DiagramAgentStatus } from "@irudd-scope/protocol/diagram-agent";
import type { TabAgentRequest } from "./plugins/diagram/connected-agent.ts";
import type { DiagramCommandRequest, DiagramCommandResponse } from "./plugins/diagram/commands.ts";
import type { DiagramEvent } from "@irudd-scope/protocol";
import type { Artifact } from "@irudd-scope/protocol";
import type { SettingsUpdate, SettingsView } from "./settings.ts";
import type { RetainedTab, TrashEntry } from "./workspace/retention.ts";
import type { Tab, Workspace } from "./workspace/contract.ts";
import type { DiagramRequest, DiagramResult } from "./plugins/diagram/contract.ts";
import type { DiagramDraft } from "./plugins/diagram/draft.ts";
import type { AgentToolStatus, SigningCertificate, UpdateStatus } from "./installation-contract.ts";
import type { RemoteStatus } from "./remote-contract.ts";
import type {
  TransferDevices,
  TransferImport,
  TransferPreview,
  TransferStatus,
} from "./transfer/contract.ts";
import type { DiagramMenuAction, DiagramMenuState } from "./menu-contract.ts";

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
  createPullRequests: (input: {
    name: string;
    title: string;
    html: string;
    repository: PullRequestsRepository;
  }) => Promise<Artifact>;
  pullRequestsCommand: (command: PullRequestsCommand) => Promise<PullRequestsReply>;
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
  diagramAgentStatus: (id: string) => Promise<DiagramAgentStatus>;
  onDiagramAgentStatus: (listener: (status: DiagramAgentStatus) => void) => () => void;
  requestDiagramAgent: (request: typeof TabAgentRequest.Type) => Promise<{ message: string }>;
  cancelDiagramAgent: (id: string) => Promise<void>;
  setDiagramMenu: (state: DiagramMenuState) => Promise<void>;
  onDiagramMenuAction: (listener: (action: DiagramMenuAction) => void) => () => void;
  onDiagramCommand: (listener: (input: DiagramCommandRequest) => void) => () => void;
  onDiagramCommandCancel: (listener: (id: string) => void) => () => void;
  diagramCommandResult: (response: DiagramCommandResponse) => Promise<void>;
  platform: string;
  setFullscreen: (enabled: boolean) => Promise<void>;
  onFullscreenChange: (listener: (enabled: boolean) => void) => () => void;
  remotes: () => Promise<RemoteStatus[]>;
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
  diagramDraft: (id: string) => Promise<DiagramDraft | null>;
  saveDiagramDraft: (id: string, draft: DiagramDraft) => Promise<void>;
  diagramEvent: (event: DiagramEvent) => Promise<void>;
  onBeforeClose: (listener: () => Promise<void>) => () => void;
  artifactLibrary: () => Promise<ArtifactLibrarySnapshot>;
  content: (id: string, revision: number) => Promise<ArtifactContent>;
  download: (id: string, revision: number) => Promise<boolean>;
  generateDiagram: (request: DiagramRequest, tabId?: string) => Promise<DiagramResult>;
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
