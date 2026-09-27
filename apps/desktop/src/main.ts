import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { ArtifactId, DEFAULT_CONNECTION_FILE, Revision, decode } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { SettingsStore, decodeSettingsUpdate } from "./settings.ts";
import { macCredentials, memoryCredentials } from "./credentials.ts";
import type { ArtifactContent, Snapshot } from "./bridge.ts";
import { DiagramRequest } from "./diagram/contract.ts";
import { openRouterProvider } from "./diagram/openrouter.ts";
import { startLocalArtifacts } from "./artifacts/local.ts";

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

  const settings = new SettingsStore(
    app.getPath("userData"),
    process.platform === "darwin" && process.env.SCOPE_SESSION_CREDENTIALS !== "1"
      ? await macCredentials(app.getPath("userData"))
      : memoryCredentials(),
    process.platform === "darwin"
      ? async (bytes) => (await safeStorage.decryptStringAsync(bytes)).result
      : undefined,
  );
  await settings.load();
  const artifacts = await startLocalArtifacts({
    directory: process.env.SCOPE_DATA_DIR ?? join(app.getPath("userData"), "artifacts"),
    connectionFile: process.env.SCOPE_CONNECTION_FILE ?? join(homedir(), DEFAULT_CONNECTION_FILE),
    port: process.env.SCOPE_PORT ? Number(process.env.SCOPE_PORT) : undefined,
  }).catch(async (error: unknown) => {
    await settings.close();
    throw error;
  });
  let current: Snapshot = { artifacts: [], connection: "connecting" };
  const client = new ScopeClient(artifacts.url, artifacts.token);
  let connection: AbortController | undefined;
  let drawing: AbortController | undefined;
  let window: BrowserWindow | undefined;
  let closing = false;
  let closed = false;
  app.on("before-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    connection?.abort();
    drawing?.abort();
    void Promise.all([artifacts.close(), settings.close()])
      .then(() => {
        closed = true;
        app.quit();
      })
      .catch(() => {
        console.error("Scope could not close its databases.");
        app.exit(1);
      });
  });
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  const cache = new Map<string, ArtifactContent>();
  const root = fileURLToPath(new URL("./renderer/", import.meta.url));
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'";
  protocol.handle("scope", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app" || !["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 404 });
    const file = resolve(
      root,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!file.startsWith(root)) return new Response(null, { status: 404 });
    try {
      const mediaTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      };
      const headers = new Headers({
        "Content-Type": mediaTypes[extname(file)] ?? "application/octet-stream",
      });
      headers.set("Content-Security-Policy", csp);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(new Uint8Array(await readFile(file)), { headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !["scope:", "data:", "blob:", "about:"].some((prefix) =>
        details.url.startsWith(prefix),
      ),
    });
  });

  function notify(): void {
    if (window && !window.isDestroyed()) window.webContents.send("scope:snapshot-changed", current);
  }
  function trust(event: IpcMainInvokeEvent) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith("scope://app/")
    )
      throw new Error("Untrusted IPC caller.");
  }
  function handle(channel: string, action: (input: unknown) => unknown) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      trust(event);
      try {
        return await action(input);
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "Scope could not complete the operation.",
        );
      }
    });
  }
  const ContentRequest = Schema.Struct({ id: ArtifactId, revision: Revision });
  async function content(input: unknown): Promise<ArtifactContent> {
    const { id, revision } = decode(ContentRequest, input);
    const key = `${id}@${revision}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const artifact = await client.get(id);
    if (artifact.revision !== revision)
      throw new Error("This artifact changed. Open the latest version.");
    const result = { artifact, bytes: await client.content(id, revision) };
    cache.set(key, result);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    return result;
  }

  handle("scope:settings", () => settings.view());
  handle("scope:workspace", () => settings.workspace());
  handle("scope:save-workspace", (input) => settings.saveWorkspace(input));
  handle("scope:save-settings", (input) => settings.update(decodeSettingsUpdate(input)));
  handle("scope:snapshot", () => current);
  handle("scope:compose", async (input) => {
    if (drawing) throw new Error("A diagram request is already running.");
    const request = decode(DiagramRequest, input);
    const active = new AbortController();
    drawing = active;
    try {
      const key = await settings.secret("apiKey");
      if (!key) throw new Error("Add an OpenRouter key in Settings first.");
      return await openRouterProvider(key).compose(request, active.signal);
    } finally {
      if (drawing === active) drawing = undefined;
    }
  });
  handle("scope:cancel-drawing", () => {
    drawing?.abort();
  });
  const SaveDiagram = Schema.Struct({
    id: ArtifactId,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    expectedRevision: Revision,
    content: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
  });
  handle("scope:save-diagram", async (value) => {
    const input = decode(SaveDiagram, value);
    const document: unknown = JSON.parse(input.content);
    if (
      !document ||
      typeof document !== "object" ||
      !("type" in document) ||
      document.type !== "excalidraw" ||
      !("elements" in document) ||
      !Array.isArray(document.elements) ||
      document.elements.length > 10_000
    )
      throw new Error("Invalid Excalidraw document.");
    const previous = input.expectedRevision ? await client.get(input.id) : undefined;
    return client.publish(
      input.id,
      {
        title: input.title,
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: `${input.id}.excalidraw`,
        expectedRevision: input.expectedRevision,
        source: previous?.source ?? { host: hostname(), agent: "scope" },
      },
      new TextEncoder().encode(input.content),
    );
  });
  handle("scope:content", content);
  handle("scope:download", async (input) => {
    const item = await content(input);
    const selection = await dialog.showSaveDialog(window!, {
      title: "Save artifact",
      defaultPath: item.artifact.fileName,
    });
    if (selection.canceled || !selection.filePath) return false;
    await writeFile(selection.filePath, item.bytes);
    return true;
  });

  async function connect() {
    connection?.abort();
    const active = new AbortController();
    connection = active;
    current = { ...current, connection: "connecting", error: undefined };
    notify();
    let delay = 1000;
    while (!active.signal.aborted) {
      try {
        await client.watch((event) => {
          if (active.signal.aborted) return;
          if (event.type === "ready") {
            void client
              .list()
              .then((artifacts) => {
                if (active.signal.aborted) return;
                const merged = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
                for (const artifact of current.artifacts)
                  if ((merged.get(artifact.id)?.revision ?? 0) < artifact.revision)
                    merged.set(artifact.id, artifact);
                current = { artifacts: [...merged.values()], connection: "connected" };
                delay = 1000;
                notify();
              })
              .catch(() => {
                if (!active.signal.aborted) {
                  current = {
                    ...current,
                    connection: "offline",
                    error: "Could not refresh the artifact list.",
                  };
                  notify();
                }
              });
          } else {
            const artifacts = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]));
            artifacts.set(event.artifact.id, event.artifact);
            current = { artifacts: [...artifacts.values()], connection: "connected" };
            notify();
          }
        }, active.signal);
      } catch (error) {
        if (active.signal.aborted) break;
        current = {
          ...current,
          connection: "offline",
          error:
            error instanceof Error ? error.message : "Cannot connect to local artifact storage.",
        };
        notify();
      }
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          active.signal.removeEventListener("abort", finish);
          done();
        };
        const timer = setTimeout(finish, delay);
        active.signal.addEventListener("abort", finish, { once: true });
        if (active.signal.aborted) finish();
      });
      delay = Math.min(delay * 2, 10_000);
    }
  }

  function createWindow() {
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 480,
      title: "Scope",
      icon,
      backgroundColor: "#ffffff",
      webPreferences: {
        preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    void window.loadURL("scope://app/index.html");
  }
  createWindow();
  void connect();
  app.on("window-all-closed", () => {
    app.quit();
  });
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
