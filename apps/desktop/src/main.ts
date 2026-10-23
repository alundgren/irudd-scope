import { initializeBuiltinPlugins } from "./plugins/registry.main.ts";
import { VoiceService } from "./voice/service.ts";
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  protocol,
  safeStorage,
  powerMonitor,
} from "electron";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConnectionFile, ScopeError } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { DesktopLifecycle } from "./lifecycle.ts";
import { DesktopStore } from "./desktop-store.ts";
import { macCredentials, memoryCredentials, windowsCredentials } from "./credentials.ts";
import { CREDENTIAL_HELPER_NAME } from "./credential-helper.ts";
import { startLocalArtifacts } from "./library/local.ts";
import { ArtifactLibrary } from "./library/library.ts";
import { registerDesktopIpc } from "./ipc.ts";
import { serveRendererContent } from "./renderer-content.ts";
import { readInstallation } from "./installation-files.ts";
import { WINDOWS_APP_ID } from "./windows-installation.ts";
import { AppUpdates } from "./updates.ts";
import { AgentTools } from "./agent-tools.ts";
import { Remotes } from "./remotes.ts";
import { MemoryService } from "./memory.ts";
import { LibrarianService } from "./librarian.ts";
import { createApplicationMenu } from "./menu.ts";
import { TabTransfers } from "./transfer/service.ts";
import { TailcatCliTransport } from "./transfer/transport.ts";
import { registerTransferLinks } from "./transfer/links.ts";
import { registerExternalLinks } from "./external-links.ts";

const transferLinks = registerTransferLinks();

app.setName("irudd-scope");
if (process.platform === "win32") app.setAppUserModelId(WINDOWS_APP_ID);
if (process.env.SCOPE_DESKTOP_DATA_DIR)
  app.setPath("userData", resolve(process.env.SCOPE_DESKTOP_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  { scheme: "scope", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
async function main() {
  await app.whenReady();
  const hideTestWindow = !app.isPackaged && process.env.SCOPE_TEST_HIDE_WINDOW === "1";
  if (hideTestWindow) app.dock?.hide();
  const icon = fileURLToPath(new URL("../resources/icon.png", import.meta.url));
  app.dock?.setIcon(icon);

  const installation =
    app.isPackaged && (process.platform === "darwin" || process.platform === "win32")
      ? await readInstallation(app.getAppPath()).catch(() => undefined)
      : undefined;

  const store = new DesktopStore(
    app.getPath("userData"),
    process.platform === "darwin" && process.env.SCOPE_SESSION_CREDENTIALS !== "1"
      ? await macCredentials(
          app.getPath("userData"),
          installation?.signingIdentity
            ? join(process.resourcesPath, "../Helpers", CREDENTIAL_HELPER_NAME)
            : undefined,
        )
      : process.platform === "win32" && process.env.SCOPE_SESSION_CREDENTIALS !== "1"
        ? windowsCredentials(safeStorage)
        : memoryCredentials(),
    process.platform === "darwin"
      ? async (bytes) => (await safeStorage.decryptStringAsync(bytes)).result
      : undefined,
  );
  await store.load();
  const voice = new VoiceService(store);
  await voice.start();
  nativeTheme.themeSource = store.settings().appearance;
  let lifecycle: DesktopLifecycle;
  let transfers: TabTransfers | undefined;
  let memory: MemoryService | undefined;
  let librarian: LibrarianService | undefined;
  let folderCommand: ReturnType<typeof registerDesktopIpc>["folderCommand"] | undefined;
  const startedMemory = () => {
    if (!memory) throw new ScopeError(503, "Scope is still starting. Retry shortly.");
    return memory;
  };
  const artifacts = await startLocalArtifacts({
    librarian: (command) => {
      if (!librarian) throw new ScopeError(503, "Scope is still starting. Retry shortly.");
      return librarian.command(command);
    },
    importLink: (url) => {
      if (!transfers)
        throw new ScopeError(503, "Scope is still starting. Retry the same link shortly.");
      return transfers.importLink(url);
    },
    voice,
    memory: {
      status: () => startedMemory().read(),
      connect: (repository) => startedMemory().connect(repository),
    },
    retroConfiguration: {
      read: () => store.retroConfiguration(),
      configure: (command) => store.saveRetroConfiguration(command),
    },
    initialize: async (artifacts) => {
      lifecycle = new DesktopLifecycle(artifacts, store);
      await lifecycle.recover();
      await initializeBuiltinPlugins(lifecycle);
    },
    deleteArtifact: (id) => lifecycle.deleteArtifact(id),
    folders: (command, input, machineId) => {
      if (!folderCommand) throw new ScopeError(503, "Scope is still starting. Retry shortly.");
      return folderCommand(command, input, machineId);
    },
    shrink: (timeoutMs) => lifecycle.shrink(timeoutMs),
    maintenanceStatus: () =>
      [lifecycle.artifacts.maintenance.latest(), store.maintenance.latest()].filter(
        (value) => value !== null,
      ),
    directory: process.env.SCOPE_DATA_DIR ?? join(app.getPath("userData"), "artifacts"),
    connectionFile:
      process.env.SCOPE_CONNECTION_FILE ??
      defaultConnectionFile(process.platform, homedir(), process.env.LOCALAPPDATA),
    port: process.env.SCOPE_PORT ? Number(process.env.SCOPE_PORT) : undefined,
  }).catch(async (error: unknown) => {
    await voice.close();
    await store.close();
    throw error;
  });
  store.maintenance.start();
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: "Scope",
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    autoHideMenuBar: true,
    icon,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: !hideTestWindow,
    },
  });
  if (installation?.platform === "win32")
    window.setAppDetails({
      appId: WINDOWS_APP_ID,
      appIconPath: join(installation.root, "Scope.exe"),
      relaunchCommand: `"${join(installation.root, "Scope.exe")}"`,
      relaunchDisplayName: "Scope",
    });
  transferLinks.attach(window);
  transfers = new TabTransfers(store, lifecycle!, new TailcatCliTransport());
  if (process.platform === "darwin") window.setWindowButtonVisibility(false);
  const client = new ScopeClient(artifacts.url, artifacts.token);
  const setSketchpadMenu = createApplicationMenu(window);
  const remotes = new Remotes(
    store,
    artifacts,
    (status) => {
      if (!window.isDestroyed()) window.webContents.send("scope:remotes-changed", status);
    },
    installation?.commit,
  );
  memory = new MemoryService(store, remotes, (status) => {
    if (!window.isDestroyed()) window.webContents.send("scope:memory-changed", status);
  });
  await memory.start();
  librarian = new LibrarianService(store, memory, (state) => {
    if (!window.isDestroyed()) window.webContents.send("scope:librarian-changed", state);
  });
  await librarian.start();
  await remotes.start();
  powerMonitor.on("resume", () => {
    void store.maintenance.check();
    void artifacts.store.maintenance.check();
    void remotes.resume().catch(() => console.error("Could not reconnect remotes after waking."));
    void memory?.retry().catch(() => console.error("Could not sync memory after waking."));
  });
  const updates = new AppUpdates(
    installation,
    join(app.getAppPath(), process.platform === "win32" ? "install.ps1" : "install.sh"),
    (status) => {
      if (!window.isDestroyed()) window.webContents.send("scope:updates-changed", status);
    },
  );
  const agentTools = new AgentTools(installation, homedir(), (status) => {
    if (!window.isDestroyed()) window.webContents.send("scope:agent-tools-changed", status);
  });
  await agentTools.syncSkills();
  const library = new ArtifactLibrary(client, (snapshot) => {
    if (!window.isDestroyed()) window.webContents.send("scope:artifact-library-changed", snapshot);
  });
  let closeReady: ((saved: boolean) => void) | undefined;
  const desktopIpc = registerDesktopIpc({
    window,
    store,
    library,
    client,
    lifecycle: lifecycle!,
    onCloseReady: (saved) => closeReady?.(saved),
    updates,
    agentTools,
    remotes,
    memory,
    librarian,
    transfers,
    setSketchpadMenu,
    onRestartToUpdate: async () => {
      if (updates.snapshot().phase !== "ready") throw new Error("No update is ready.");
      if (agentTools.isBusy()) throw new Error("Wait for the agent tools installation to finish.");
      await close(true);
    },
  });
  folderCommand = desktopIpc.folderCommand;
  const externalLinks = registerExternalLinks(window);
  lifecycle!.onRemoved = (ids) => desktopIpc.cancelTabs(ids);
  lifecycle!.onRetentionChanged = (tabs) => {
    if (!window.isDestroyed()) window.webContents.send("scope:retention-changed", tabs);
  };
  lifecycle!.onClosed = (ids) => {
    if (!window.isDestroyed()) window.webContents.send("scope:tabs-closed", ids);
  };
  let closing = false;
  let closed = false;
  async function close(restart = false) {
    if (closing || closed) return;
    closing = true;
    desktopIpc.cancelPending();
    if (!window.isDestroyed()) {
      const saved = await new Promise<boolean>((done) => {
        const timer = setTimeout(() => {
          closeReady = undefined;
          done(false);
        }, 10_000);
        closeReady = (value) => {
          clearTimeout(timer);
          closeReady = undefined;
          done(value);
        };
        window.webContents.send("scope:before-close");
      });
      if (!saved) {
        const answer = await dialog.showMessageBox(window, {
          type: "warning",
          message: "Scope could not save the workspace.",
          detail: "Keep the window open to retry, or quit without the latest changes.",
          buttons: ["Keep open", "Quit without saving"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response === 0) {
          closing = false;
          await desktopIpc.resumePending();
          return;
        }
      }
    }
    if (restart) {
      try {
        const executable = await updates.activate();
        app.relaunch({ execPath: executable, args: [] });
      } catch (error) {
        closing = false;
        await desktopIpc.resumePending();
        throw error;
      }
    }
    await Promise.all([updates.cancel(), agentTools.cancel()]);
    desktopIpc.dispose();
    externalLinks.dispose();
    library.close();
    await transfers?.close();
    await remotes.close();
    await librarian?.close();
    await memory?.close();
    await voice.close();
    await Promise.all([artifacts.close(), store.close()]);
    closed = true;
    app.quit();
  }
  function requestClose(event: { preventDefault: () => void }) {
    if (closed) return;
    event.preventDefault();
    void close().catch(() => {
      console.error("Scope could not close its databases.");
      app.exit(1);
    });
  }
  app.on("before-quit", requestClose);
  app.on("second-instance", () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  serveRendererContent(fileURLToPath(new URL("./renderer", import.meta.url)));
  window.on("close", requestClose);
  window.once("ready-to-show", () => {
    if (hideTestWindow) return;
    window.maximize();
    window.show();
  });
  void window.loadURL("scope://app/index.html");
  void library.connect();
  void updates
    .prune()
    .catch(() => console.error("Could not remove old Scope builds."))
    .then(() => updates.check());
  app.on("window-all-closed", () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main().catch((error: unknown) => {
    console.error(
      `Scope could not start: ${error instanceof Error ? error.message : "Check desktop permissions."}`,
    );
    app.quit();
  });
}
