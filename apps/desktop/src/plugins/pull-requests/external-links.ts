import { app, BrowserWindow, shell, type WebContents, type WebFrameMain } from "electron";
import { decode } from "@irudd-scope/protocol";
import type { MainPluginContext } from "../main-api.ts";
import { PullRequestsExternalLink, PullRequestsFrame, pullRequestsArtifactId } from "./contract.ts";

export function registerPullRequestsExternalLinks({
  window,
  handle,
  workspace,
  artifacts,
}: MainPluginContext) {
  const frames = new Map<number, PullRequestsFrame>();
  const watching = new Map<WebContents, () => void>();

  async function owner(input: PullRequestsFrame | PullRequestsExternalLink) {
    const tab = (await workspace()).tabs.find((entry) => entry.id === input.tabId);
    if (!tab || tab.type !== "pull-requests") throw new Error("This PR inbox is no longer open.");
    const artifact = await artifacts.get(pullRequestsArtifactId(tab.state));
    if (artifact.kind !== "pull-requests" || artifact.name !== input.name)
      throw new Error("This link belongs to another PR inbox.");
  }
  async function open(value: unknown) {
    const input = decode(PullRequestsExternalLink, value);
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("PR inbox links must use HTTP or HTTPS without embedded credentials.");
    await owner(input);
    await shell.openExternal(url.href);
  }
  handle("scope:open-pull-requests-link", open);
  handle("scope:register-pull-requests-frame", async (value) => {
    const input = decode(PullRequestsFrame, value);
    await owner(input);
    const candidates = window.webContents.mainFrame.frames.filter(
      (frame) =>
        frame.name === `scope-pull-requests-${input.tabId}-${input.channel}` &&
        frame.url.startsWith("about:srcdoc"),
    );
    if (candidates.length !== 1)
      throw new Error("The PR inbox document is not ready. Retry the link.");
    for (const [id, frame] of frames) if (frame.tabId === input.tabId) frames.delete(id);
    frames.set(candidates[0]!.frameTreeNodeId, input);
  });
  handle("scope:unregister-pull-requests-frame", (value) => {
    const input = decode(PullRequestsFrame, value);
    for (const [id, frame] of frames)
      if (frame.tabId === input.tabId && frame.channel === input.channel) frames.delete(id);
  });
  function identity(frame: WebFrameMain | null | undefined): PullRequestsFrame | undefined {
    while (frame) {
      const registered = frames.get(frame.frameTreeNodeId);
      if (registered) return registered;
      frame = frame.parent;
    }
  }
  function watch(contents: WebContents) {
    if (watching.has(contents)) return;
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      const source = event.initiator;
      const registered = identity(source);
      if (!source || !registered) return;
      let url: URL;
      try {
        url = new URL(event.url);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        const host = new URL(window.webContents.mainFrame.url);
        if (
          contents !== window.webContents ||
          url.protocol !== host.protocol ||
          url.host !== host.host ||
          url.pathname !== host.pathname ||
          url.search !== host.search ||
          !url.href.includes("#")
        )
          return;
        // srcdoc fragment links resolve against the host URL instead of the inbox document.
        event.preventDefault();
        void source
          .executeJavaScript(`location.hash = ${JSON.stringify(url.hash || "#")}`)
          .catch(() => {});
        return;
      }
      event.preventDefault();
      if (contents !== window.webContents) {
        // Modifier clicks can navigate before their BrowserWindow finishes construction.
        setImmediate(() => {
          if (!contents.isDestroyed()) BrowserWindow.fromWebContents(contents)?.destroy();
        });
      }
      void (async () => {
        let error: string | undefined;
        try {
          await open({ name: registered.name, tabId: registered.tabId, url: url.href });
        } catch (failure) {
          error = failure instanceof Error ? failure.message : "Could not open the browser.";
        }
        if (!window.isDestroyed())
          window.webContents.send("scope:pull-requests-link-result", {
            ...registered,
            url: url.href,
            error,
          });
      })();
    };
    const cleanup = () => {
      contents.removeListener("will-frame-navigate", navigate);
      contents.removeListener("destroyed", cleanup);
      watching.delete(contents);
    };
    watching.set(contents, cleanup);
    contents.on("will-frame-navigate", navigate);
    contents.once("destroyed", cleanup);
  }
  const created = (_event: Electron.Event, contents: WebContents) => watch(contents);
  app.on("web-contents-created", created);
  watch(window.webContents);
  return {
    dispose() {
      app.removeListener("web-contents-created", created);
      for (const cleanup of watching.values()) cleanup();
      frames.clear();
    },
  };
}
