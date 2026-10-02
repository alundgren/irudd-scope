import { app, type BrowserWindow } from "electron";
import { readTransferUrl } from "@irudd-scope/protocol/transfer";

export function registerTransferLinks() {
  let window: BrowserWindow | undefined;
  let ready = false;
  const pending: { url: string; kind: "pair" | "tab" }[] = [];
  function receive(url: string) {
    let link;
    try {
      link = { url, kind: readTransferUrl(url).mode };
    } catch {
      return;
    }
    if (!ready || !window || window.isDestroyed()) {
      if (pending.length < 4) pending.push(link);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send("scope:transfer-link", link);
  }
  app.on("open-url", (event, url) => {
    event.preventDefault();
    receive(url);
  });
  app.on("second-instance", (_event, argv) => {
    for (const arg of argv) if (arg.startsWith("scope-transfer:")) receive(arg);
  });
  for (const arg of process.argv) if (arg.startsWith("scope-transfer:")) receive(arg);
  return {
    attach(target: BrowserWindow) {
      window = target;
      if (app.isPackaged && process.platform === "darwin")
        app.setAsDefaultProtocolClient("scope-transfer");
      target.webContents.on("did-finish-load", () => {
        ready = true;
        for (const link of pending.splice(0)) receive(link.url);
      });
      target.webContents.on("did-start-loading", () => {
        ready = false;
      });
    },
  };
}
