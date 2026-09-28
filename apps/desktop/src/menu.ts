import { Menu, MenuItem, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { DiagramMenuAction, DiagramMenuState } from "./menu-contract.ts";

export function createApplicationMenu(window: BrowserWindow) {
  let target: DiagramMenuState = null;
  function send(action: DiagramMenuAction["action"]) {
    if (target && !window.isDestroyed())
      window.webContents.send("scope:diagram-menu-action", { tabId: target.tabId, action });
  }
  const menu = Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { id: "file", role: "fileMenu" },
    { role: "editMenu" },
    { id: "view", role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  const saveCopy = new MenuItem({
    id: "diagram-save-copy",
    label: "Save a copy",
    enabled: false,
    click: () => send("save-copy"),
  });
  const fit = new MenuItem({
    id: "diagram-fit",
    label: "Fit to canvas",
    enabled: false,
    click: () => send("fit"),
  });
  for (const [id, item] of [
    ["file", saveCopy],
    ["view", fit],
  ] as const) {
    const submenu = menu.getMenuItemById(id)!.submenu!;
    submenu.insert(0, item);
    submenu.insert(1, new MenuItem({ type: "separator" }));
  }
  Menu.setApplicationMenu(menu);
  return (state: DiagramMenuState) => {
    target = state;
    saveCopy.enabled = state?.canSaveCopy ?? false;
    fit.enabled = state?.canFit ?? false;
  };
}
