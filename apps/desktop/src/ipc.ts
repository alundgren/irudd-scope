import { GuestId, GuestName } from "@irudd-scope/protocol/guest";
import type { GuestMutations } from "./guest/mutations.ts";
import { GuestInput } from "./guest/recovery-contract.ts";
import type { GuestCatalogs } from "./guest/catalog.ts";
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
import { Tab, Uuid } from "./workspace/contract.ts";
import { TrashEntry } from "./workspace/retention.ts";
import { TabEventEnvelope } from "./plugins/events.ts";
import type { AgentTools } from "./agent-tools.ts";
import type { AppUpdates } from "./updates.ts";
import type { Remotes } from "./remotes.ts";
import type { MemoryService } from "./memory.ts";
import type { LibrarianService } from "./librarian.ts";
import type { HarnessesService } from "./harnesses.ts";
import { RemoteId } from "@irudd-scope/protocol/remote";
import { openKeychainAccess } from "./signing.ts";
import { SketchpadMenuState } from "./menu-contract.ts";
import type { GuestConnections } from "./guest/service.ts";
import { GuestAccess } from "./guest/contract.ts";

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
  memory,
  librarian,
  harnesses,
  guests,
  guestCatalogs,
  guestMutations,
  onRestartToUpdate,
  setSketchpadMenu,
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
  memory: MemoryService;
  librarian: LibrarianService;
  harnesses: HarnessesService;
  guests: GuestConnections;
  guestCatalogs: GuestCatalogs;
  guestMutations: GuestMutations;
  onRestartToUpdate: () => Promise<void>;
  setSketchpadMenu: (state: SketchpadMenuState) => void;
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

  handle("scope:set-sketchpad-menu", (input) =>
    setSketchpadMenu(decode(SketchpadMenuState, input)),
  );
  handle("scope:set-fullscreen", (input) => {
    window.setFullScreen(decode(Schema.Boolean, input));
  });
  const enteredFullscreen = () => window.webContents.send("scope:fullscreen-changed", true);
  const leftFullscreen = () => window.webContents.send("scope:fullscreen-changed", false);
  window.on("enter-full-screen", enteredFullscreen);
  window.on("leave-full-screen", leftFullscreen);

  const plugins = registerMainPlugins({
    guests,
    guestCatalogs,
    window,
    handle,
    store,
    client,
    memory,
    harnesses,
    lifecycle,
    remotes,
    artifacts: lifecycle.artifacts,
    workspace: () => lifecycle.workspace(),
  });
  const stopPromptEvents = library.onPromptsChanged((event) => {
    if (!window.isDestroyed()) window.webContents.send("scope:prompts-changed", event);
  });
  const stopPromptReconnects = library.onPromptsReconnected(() => {
    if (!window.isDestroyed()) window.webContents.send("scope:prompts-reconnected");
  });
  const stopRetroEvents = library.onRetroChanged((event) => {
    if (!window.isDestroyed()) window.webContents.send("scope:retro-changed", event);
  });
  const stopRetroReconnects = library.onRetroReconnected(() => {
    if (!window.isDestroyed()) window.webContents.send("scope:retro-reconnected");
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
  handle("scope:memory", () => memory.read());
  handle("scope:librarian-read", () => librarian.projected());
  handle("scope:librarian-human", (input) => librarian.human(input));
  handle("scope:choose-memory-folder", async () => {
    const selected = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    if (!selected.canceled && selected.filePaths[0])
      await librarian.command({ action: "local", root: selected.filePaths[0], initialize: false });
    return memory.read();
  });
  handle("scope:set-memory-enabled", (input) => memory.setEnabled(decode(Schema.Boolean, input)));
  handle("scope:set-memory-sync-enabled", (input) =>
    memory.setSyncEnabled(decode(Schema.Boolean, input)),
  );
  handle("scope:retry-memory", () => memory.retry());
  handle("scope:copy-memory-request", (input) =>
    clipboard.writeText(
      memory.agentRequest(decode(Schema.Literals(["create", "conflicts"]), input)),
    ),
  );
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
  handle("scope:set-tab-hidden", (input) => {
    const { id, hidden } = decode(Schema.Struct({ id: Uuid, hidden: Schema.Boolean }), input);
    return lifecycle.setTabHidden(id, hidden);
  });
  handle("scope:defer-guest-tab", (input) => {
    const { id, workspace } = decode(Schema.Struct({ id: Uuid, workspace: Schema.Unknown }), input);
    return lifecycle.deferGuestTab(id, workspace);
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
  handle("scope:guest-prepare", (input) => guestMutations.command("prepare", input));
  handle("scope:guest-execute", (input) => guestMutations.command("execute", input));
  handle("scope:guest-operation-status", (input) => guestMutations.command("status", input));
  handle("scope:guest-reconcile", (input) => guestMutations.command("reconcile", input));
  handle("scope:guest-recovery", (input) => store.guestRecovery.read(decode(Uuid, input)));
  handle("scope:save-guest-input", (input) => store.guestRecovery.save(decode(GuestInput, input)));
  handle("scope:discard-guest-input", (input) => {
    const { id, kind, revision } = decode(
      Schema.Struct({ id: Uuid, kind: Schema.Literals(["html", "action"]), revision: Revision }),
      input,
    );
    return store.guestRecovery.discard(id, kind, revision);
  });
  const guestRead = Schema.Struct({ id: Uuid, revision: Revision });
  handle("scope:guest-catalog", () => guestCatalogs.snapshot());
  handle("scope:guest-content", (input) => {
    const { id, revision } = decode(guestRead, input);
    return guestCatalogs.content(id, revision);
  });
  handle("scope:guest-download", async (input) => {
    const { id, revision } = decode(guestRead, input);
    const item = await guestCatalogs.content(id, revision);
    const result = await dialog.showSaveDialog(window, { defaultPath: item.artifact.fileName });
    if (result.canceled || !result.filePath) return false;
    // Recheck after the human leaves the save dialog; source access may have been revoked.
    const current = await guestCatalogs.content(id, revision);
    await writeFile(result.filePath, current.bytes);
    return true;
  });
  handle("scope:guest-status", () => guests.status());
  handle("scope:set-guest-access", (input) => {
    const value = decode(GuestAccess, input);
    return guests.setEnabled(value.peerId, value.enabled);
  });
  handle("scope:retry-guest", (input) => guests.reconnect(decode(GuestId, input)));
  handle("scope:guest-devices", () => guests.devices());
  handle("scope:create-guest-invitation", (input) =>
    guests.pairing.create(decode(GuestName, input)),
  );
  handle("scope:copy-guest-invitation", async (input) =>
    clipboard.writeText(guests.pairing.invitation(decode(GuestId, input))),
  );
  handle("scope:inspect-guest-invitation", async (input) =>
    guests.pairing.inspect(await clipboard.readText(), decode(GuestName, input)),
  );
  handle("scope:approve-guest-pairing", (input) => guests.pairing.approve(decode(GuestId, input)));
  handle("scope:cancel-guest-pairing", (input) => guests.cancelPairing(decode(GuestId, input)));
  handle("scope:guest-pairing-status", () => guests.pairing.status());
  handle("scope:forget-guest", (input) => guests.forget(decode(GuestId, input)));
  handle("scope:workspace", () => lifecycle.workspace());
  handle("scope:save-workspace", (input) => lifecycle.saveWorkspace(input));
  handle("scope:close-ready", (input) => onCloseReady(decode(Schema.Boolean, input)));
  handle("scope:save-settings", async (input) => {
    const result = await store.saveSettings(decodeSettingsUpdate(input));
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
    resumePending: () => plugins.resumePullRequests(),
    cancelPending: () => plugins.cancelPullRequests(),
    cancelTabs: (ids: string[]) => plugins.cancelTabs(ids),
    hiddenTabs: (ids: string[]) => plugins.hiddenTabs(ids),
    folderCommand: plugins.folderCommand,
    watchFolder: plugins.watchFolder,
    dispose: () => {
      stopPromptEvents();
      stopPromptReconnects();
      stopRetroEvents();
      stopRetroReconnects();
      stopPullRequestsEvents();
      stopPullRequestsReconnects();
      window.removeListener("enter-full-screen", enteredFullscreen);
      window.removeListener("leave-full-screen", leftFullscreen);
      plugins.dispose();
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
