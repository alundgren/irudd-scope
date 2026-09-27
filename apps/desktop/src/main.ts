import { app, BrowserWindow, dialog, nativeTheme, protocol, safeStorage } from "electron";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONNECTION_FILE } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { DesktopStore } from "./desktop-store.ts";
import { macCredentials, memoryCredentials } from "./credentials.ts";
import { startLocalArtifacts } from "./library/local.ts";
import { ArtifactLibrary } from "./library/library.ts";
import { registerDesktopIpc } from "./ipc.ts";
import { configureRendererSecurity, restrictRendererNavigation } from "./renderer-security.ts";
import { readInstallation } from "./installation-files.ts";
import { AppUpdates } from "./updates.ts";
import { AgentTools } from "./agent-tools.ts";

app.setName("irudd-scope");
if (process.env.SCOPE_DESKTOP_DATA_DIR)
  app.setPath("userData", resolve(process.env.SCOPE_DESKTOP_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  { scheme: "scope", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
async function main() {
  await app.whenReady();
  const icon = fileURLToPath(new URL("../resources/icon.png", import.meta.url));
  app.dock?.setIcon(icon);

  const store = new DesktopStore(
    app.getPath("userData"),
    process.platform === "darwin" && process.env.SCOPE_SESSION_CREDENTIALS !== "1"
      ? await macCredentials(app.getPath("userData"))
      : memoryCredentials(),
    process.platform === "darwin"
      ? async (bytes) => (await safeStorage.decryptStringAsync(bytes)).result
      : undefined,
  );
  await store.load();
  nativeTheme.themeSource = store.settings().appearance;
  const artifacts = await startLocalArtifacts({
    directory: process.env.SCOPE_DATA_DIR ?? join(app.getPath("userData"), "artifacts"),
    connectionFile: process.env.SCOPE_CONNECTION_FILE ?? join(homedir(), DEFAULT_CONNECTION_FILE),
    port: process.env.SCOPE_PORT ? Number(process.env.SCOPE_PORT) : undefined,
  }).catch(async (error: unknown) => {
    await store.close();
    throw error;
  });
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: "Scope",
    icon,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  const client = new ScopeClient(artifacts.url, artifacts.token);
  const installation =
    app.isPackaged && process.platform === "darwin"
      ? await readInstallation(app.getAppPath()).catch(() => undefined)
      : undefined;
  const updates = new AppUpdates(installation, join(app.getAppPath(), "install.sh"), (status) => {
    if (!window.isDestroyed()) window.webContents.send("scope:updates-changed", status);
  });
  const agentTools = new AgentTools(installation, homedir(), (status) => {
    if (!window.isDestroyed()) window.webContents.send("scope:agent-tools-changed", status);
  });
  const library = new ArtifactLibrary(client, (snapshot) => {
    if (!window.isDestroyed()) window.webContents.send("scope:artifact-library-changed", snapshot);
  });
  let closeReady: ((saved: boolean) => void) | undefined;
  const desktopIpc = registerDesktopIpc({
    window,
    store,
    library,
    client,
    onCloseReady: (saved) => closeReady?.(saved),
    updates,
    agentTools,
    onRestartToUpdate: async () => {
      if (updates.snapshot().phase !== "ready") throw new Error("No update is ready.");
      if (agentTools.isBusy()) throw new Error("Wait for the agent tools installation to finish.");
      await close(true);
    },
  });
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
        throw error;
      }
    }
    await Promise.all([updates.cancel(), agentTools.cancel()]);
    desktopIpc.dispose();
    library.close();
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
  configureRendererSecurity(fileURLToPath(new URL("./renderer", import.meta.url)));
  restrictRendererNavigation(window.webContents);
  window.on("close", requestClose);
  window.once("ready-to-show", () => window.show());
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
