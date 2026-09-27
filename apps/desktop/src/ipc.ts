import { dialog, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactId, Revision, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { DesktopStore } from "./desktop-store.ts";
import type { ArtifactLibrary } from "./library/library.ts";
import { decodeSettingsUpdate } from "./settings.ts";
import { registerMainPlugins } from "./plugins/registry.main.ts";
import { TabEventEnvelope } from "./plugins/events.ts";

export function registerDesktopIpc({
  window,
  store,
  library,
  client,
  onCloseReady,
}: {
  window: BrowserWindow;
  store: DesktopStore;
  library: ArtifactLibrary;
  client: ScopeClient;
  onCloseReady: (saved: boolean) => void;
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

  const plugins = registerMainPlugins({ handle, store, client });
  handle("scope:publish-tab-event", async (input) => {
    const envelope = decode(TabEventEnvelope, input);
    const workspace = await store.workspace();
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
  handle("scope:workspace", () => store.workspace());
  handle("scope:save-workspace", (input) => store.saveWorkspace(input));
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
    cancelPending: () => plugins.cancelPending(),
    dispose: () => {
      plugins.cancelPending();
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
