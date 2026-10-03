import { connectedDiagramAgents } from "./plugins/diagram/connected-agent.ts";
import { diagramCommands } from "./plugins/diagram/command-main.ts";
import { clipboard, dialog, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactId, Revision, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { DesktopStore } from "./desktop-store.ts";
import type { ArtifactLibrary } from "./library/library.ts";
import { decodeSettingsUpdate } from "./settings.ts";
import { registerMainPlugins } from "./plugins/registry.main.ts";
import type { DesktopLifecycle } from "./lifecycle.ts";
import { Tab, Uuid, tabArtifactId } from "./workspace/contract.ts";
import { TrashEntry } from "./workspace/retention.ts";
import { TabEventEnvelope } from "./plugins/events.ts";
import type { AgentTools } from "./agent-tools.ts";
import type { AppUpdates } from "./updates.ts";
import type { Remotes } from "./remotes.ts";
import { RemoteId } from "@irudd-scope/protocol/remote";
import { openKeychainAccess } from "./signing.ts";
import { DiagramCommand, DiagramReply } from "@irudd-scope/protocol/diagram";
import { DiagramSyncCommand, DiagramSyncReply } from "@irudd-scope/protocol/diagram-sync";
import { DiagramMenuState } from "./menu-contract.ts";
import type { TabTransfers } from "./transfer/service.ts";
import { TransferId, TransferName } from "@irudd-scope/protocol/transfer";

export function registerDesktopIpc({
  window,
  store,
  library,
  client,
  onCloseReady,
  lifecycle,
  updates,
  agentTools,
  remotes,
  transfers,
  onRestartToUpdate,
  setDiagramMenu,
}: {
  lifecycle: DesktopLifecycle;
  window: BrowserWindow;
  store: DesktopStore;
  library: ArtifactLibrary;
  client: ScopeClient;
  onCloseReady: (saved: boolean) => void;
  updates: AppUpdates;
  agentTools: AgentTools;
  remotes: Remotes;
  transfers: TabTransfers;
  onRestartToUpdate: () => Promise<void>;
  setDiagramMenu: (state: DiagramMenuState) => void;
}) {
  const eventListeners = new Set<(event: TabEventEnvelope) => void | Promise<void>>();

  function handle(channel: string, action: (input: unknown) => unknown) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame.url.startsWith("scope://app/")
      )
        throw new Error("Untrusted IPC caller.");
      try {
        return await action(input);
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "Scope could not complete the operation.",
        );
      }
    });
  }

  const diagrams = diagramCommands(
    (request) => window.webContents.send("scope:diagram-command", request),
    (id) => {
      if (!window.isDestroyed()) window.webContents.send("scope:diagram-command-cancel", id);
    },
    client,
  );
  const connectedAgents = connectedDiagramAgents(
    async (command, signal) => decode(DiagramReply, await diagrams.run(command, signal)),
    (status) => {
      if (!window.isDestroyed()) window.webContents.send("scope:diagram-agent-status", status);
    },
    async (id) => (await lifecycle.workspace()).tabs.find((tab) => tabArtifactId(tab) === id)?.id,
  );
  const rendererUnavailable = () => {
    diagrams.cancelAll();
    connectedAgents.close();
  };
  const navigated = (
    _event: Electron.Event,
    _url: string,
    _statusCode: number,
    _statusText: string,
    mainFrame: boolean,
  ) => {
    if (mainFrame) rendererUnavailable();
  };
  window.webContents.on("render-process-gone", rendererUnavailable);
  window.webContents.on("did-frame-navigate", navigated);
  handle("scope:diagram-agent-status", (input) =>
    connectedAgents.status(decode(ArtifactId, input)),
  );
  handle("scope:request-diagram-agent", (input) => connectedAgents.request(input));
  handle("scope:cancel-diagram-agent", (input) =>
    connectedAgents.cancel(decode(ArtifactId, input)),
  );
  handle("scope:diagram-command-result", (input) => diagrams.reply(input));
  handle("scope:set-diagram-menu", (input) => setDiagramMenu(decode(DiagramMenuState, input)));
  handle("scope:set-fullscreen", (input) => {
    window.setFullScreen(decode(Schema.Boolean, input));
  });
  const enteredFullscreen = () => window.webContents.send("scope:fullscreen-changed", true);
  const leftFullscreen = () => window.webContents.send("scope:fullscreen-changed", false);
  window.on("enter-full-screen", enteredFullscreen);
  window.on("leave-full-screen", leftFullscreen);

  const plugins = registerMainPlugins({
    window,
    handle,
    store,
    client,
    artifacts: lifecycle.artifacts,
    workspace: () => lifecycle.workspace(),
  });
  const stopPlanEvents = library.onPlanChanged((event) => {
    if (!window.isDestroyed()) window.webContents.send("scope:plan-changed", event);
  });
  const stopPlanReconnects = library.onPlanReconnected(() => {
    if (!window.isDestroyed()) window.webContents.send("scope:plan-reconnected");
  });
  const stopPullRequestsEvents = library.onPullRequestsChanged((event) => {
    if (!window.isDestroyed()) window.webContents.send("scope:pull-requests-changed", event);
  });
  const stopPullRequestsReconnects = library.onPullRequestsReconnected(() => {
    if (!window.isDestroyed()) window.webContents.send("scope:pull-requests-reconnected");
  });
  handle("scope:remotes", () => remotes.snapshot());
  handle("scope:pair-remote", (input) =>
    remotes.pair(decode(Schema.String.check(Schema.isMaxLength(4096)), input)),
  );
  handle("scope:set-remote-enabled", (input) => {
    const { id, enabled } = decode(Schema.Struct({ id: RemoteId, enabled: Schema.Boolean }), input);
    return remotes.setEnabled(id, enabled);
  });
  handle("scope:remove-remote", (input) => remotes.remove(decode(RemoteId, input)));
  handle("scope:retry-remote-update", (input) => remotes.retryUpdate(decode(RemoteId, input)));
  handle("scope:updates", () => updates.snapshot());
  handle("scope:check-for-updates", () => {
    if (agentTools.isBusy()) throw new Error("Wait for the agent tools installation to finish.");
    void updates.check();
  });
  handle("scope:cancel-update", () => updates.cancel());
  handle("scope:restart-to-update", () => onRestartToUpdate());
  handle("scope:signing-certificate", () => updates.signingCertificate());
  handle("scope:open-keychain-access", () => openKeychainAccess());
  function changeSigningCertificate(reference: string | null) {
    if (agentTools.isBusy()) throw new Error("Wait for the agent tools installation to finish.");
    void updates.setSigningCertificate(reference);
  }
  handle("scope:connect-signing-certificate", (input) =>
    changeSigningCertificate(
      decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)), input),
    ),
  );
  handle("scope:disconnect-signing-certificate", () => changeSigningCertificate(null));
  handle("scope:agent-tools", () => agentTools.snapshot());
  function installTool(action: () => unknown) {
    if (["checking", "building"].includes(updates.snapshot().phase))
      throw new Error("Wait for the app update to finish, or cancel it first.");
    return action();
  }
  handle("scope:install-cli", () => installTool(() => agentTools.installCli()));
  handle("scope:remove-cli", () => installTool(() => agentTools.removeCli()));
  handle("scope:install-skill", () => installTool(() => agentTools.installSkill()));
  handle("scope:remove-skill", () => installTool(() => agentTools.removeSkill()));
  handle("scope:publish-tab-event", async (input) => {
    const envelope = decode(TabEventEnvelope, input);
    const workspace = await lifecycle.workspace();
    if (
      !workspace?.tabs.some((tab) => tab.id === envelope.tabId && tab.groupId === envelope.groupId)
    )
      throw new Error("The event sender is not an open tab in this group.");
    for (const listener of eventListeners) {
      try {
        void Promise.resolve(listener(structuredClone(envelope))).catch(() => {
          console.error("A desktop tab event handler failed.");
        });
      } catch {
        console.error("A desktop tab event handler failed.");
      }
    }
  });
  handle("scope:settings", () => store.settings());
  handle("scope:provider-settings", () => store.providerSettings());
  handle("scope:open-tab", (input) => {
    const { tab, artifactRevision } = decode(
      Schema.Struct({ tab: Tab, artifactRevision: Schema.optional(Revision) }),
      input,
    );
    return lifecycle.openTab(tab, artifactRevision);
  });
  handle("scope:retained-tabs", () => lifecycle.artifacts.retainedTabs());
  handle("scope:set-tab-permanent", (input) => {
    const { id, permanent } = decode(Schema.Struct({ id: Uuid, permanent: Schema.Boolean }), input);
    return lifecycle.setTabPermanent(id, permanent);
  });
  handle("scope:restore-tab", (input) => lifecycle.restoreTab(decode(Uuid, input)));
  handle("scope:empty-trash", (input) =>
    lifecycle.emptyTrash(decode(Schema.Array(TrashEntry), input)),
  );
  const visibleTabs = (input: unknown) => {
    const ids = decode(Schema.Array(Uuid), input);
    return window.isVisible() && !window.isMinimized() ? ids : [];
  };
  handle("scope:visible-tabs", (input) => lifecycle.reportVisibleTabs(visibleTabs(input)));
  handle("scope:check-tab-retention", (input) => lifecycle.checkRetention(visibleTabs(input)));
  handle("scope:close-tab", async (input) => {
    await lifecycle.closeTab(decode(Uuid, input));
  });
  handle("scope:transfer-devices", () => transfers.devices());
  handle("scope:create-pairing", (input) => transfers.createPairing(decode(TransferName, input)));
  handle("scope:copy-pairing-secret", async (input) => {
    await clipboard.writeText(transfers.pairingSecret(decode(TransferId, input)));
  });
  handle("scope:pair-scope", (input) => transfers.pair(input));
  handle("scope:forget-scope", (input) => transfers.forget(decode(TransferId, input)));
  handle("scope:send-tab", (input) => transfers.send(input));
  handle("scope:transfer-status", (input) => transfers.status(decode(TransferId, input)));
  handle("scope:cancel-transfer", (input) => transfers.cancel(decode(TransferId, input)));
  const TransferLink = Schema.String.check(Schema.isMaxLength(8192));
  handle("scope:inspect-transfer", (input) => transfers.inspect(decode(TransferLink, input)));
  handle("scope:import-transfer", (input) => transfers.import(decode(TransferLink, input)));
  handle("scope:workspace", () => lifecycle.workspace());
  handle("scope:save-workspace", (input) => lifecycle.saveWorkspace(input));
  handle("scope:close-ready", (input) => onCloseReady(decode(Schema.Boolean, input)));
  handle("scope:save-settings", async (input) => {
    const result = await store.saveSettings(decodeSettingsUpdate(input));
    if (!result.diagramGenerationEnabled) plugins.cancelPending();
    nativeTheme.themeSource = result.appearance;
    return result;
  });
  handle("scope:artifact-library", () => library.snapshot());
  const ContentRequest = Schema.Struct({ id: ArtifactId, revision: Revision });
  async function content(input: unknown) {
    const { id, revision } = decode(ContentRequest, input);
    return library.content(id, revision);
  }
  handle("scope:content", content);
  handle("scope:download", async (input) => {
    const item = await content(input);
    const selection = await dialog.showSaveDialog(window, {
      title: "Save artifact",
      defaultPath: item.artifact.fileName,
    });
    if (selection.canceled || !selection.filePath) return false;
    await writeFile(selection.filePath, item.bytes);
    return true;
  });

  return {
    diagramAgent: (command: Parameters<typeof connectedAgents.run>[0], signal: AbortSignal) =>
      connectedAgents.run(command, signal),
    diagram: async (command: DiagramCommand, signal: AbortSignal) =>
      decode(DiagramReply, await diagrams.run(command, signal)),
    syncDiagram: async (request: DiagramSyncCommand, id: string, signal: AbortSignal) =>
      decode(DiagramSyncReply, await diagrams.run({ action: "sync", id, request }, signal)),
    resumePending: () => plugins.resumePullRequests(),
    cancelPending: () => {
      plugins.cancelPending();
      plugins.cancelPullRequests();
      diagrams.cancelAll();
      connectedAgents.close();
    },
    cancelTabs: (ids: string[]) => {
      plugins.cancelTabs(ids);
      connectedAgents.cancelTabs(ids);
    },
    dispose: () => {
      stopPlanEvents();
      stopPlanReconnects();
      stopPullRequestsEvents();
      stopPullRequestsReconnects();
      window.webContents.removeListener("render-process-gone", rendererUnavailable);
      window.webContents.removeListener("did-frame-navigate", navigated);
      window.removeListener("enter-full-screen", enteredFullscreen);
      window.removeListener("leave-full-screen", leftFullscreen);
      plugins.cancelPending();
      plugins.dispose();
      diagrams.cancelAll();
      connectedAgents.close();
      eventListeners.clear();
    },
    onTabEvent: (listener: (event: TabEventEnvelope) => void | Promise<void>) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };
}
