import { app, BrowserWindow, shell, type WebContents, type WebFrameMain } from "electron";

export function registerExternalLinks(window: BrowserWindow) {
  const watching = new Map<WebContents, () => void>();
  function belongsToWorkspace(frame: WebFrameMain) {
    return frame !== window.webContents.mainFrame && frame.top === window.webContents.mainFrame;
  }
  function watch(contents: WebContents) {
    if (watching.has(contents)) return;
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      const source = event.initiator;
      if (event.defaultPrevented || !source || !belongsToWorkspace(source)) return;
      if (contents === window.webContents) {
        let target: WebFrameMain | null = source;
        while (target && target !== event.frame) target = target.parent;
        // Loading an embedded frame or submitting a form into it keeps the document open.
        if (!target) return;
      }
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
        // srcdoc anchors resolve against the workspace URL instead of the artifact.
        event.preventDefault();
        void source
          .executeJavaScript(`location.hash = ${JSON.stringify(url.hash || "#")}`)
          .catch(() => {});
        return;
      }
      event.preventDefault();
      if (contents !== window.webContents) {
        // Modifier clicks can navigate before the popup window finishes construction.
        setImmediate(() => {
          if (!contents.isDestroyed()) BrowserWindow.fromWebContents(contents)?.destroy();
        });
      }
      if (url.username || url.password) return;
      void shell.openExternal(url.href).catch(() => {
        console.error("Scope could not open the link in the default browser.");
      });
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
    },
  };
}
