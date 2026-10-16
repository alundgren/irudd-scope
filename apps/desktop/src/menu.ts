import { Menu, MenuItem, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { SketchpadMenuState } from "./menu-contract.ts";

export function createApplicationMenu(window: BrowserWindow) {
  let target: SketchpadMenuState = null;
  const menu = Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { id: "file", role: "fileMenu" },
    { role: "editMenu" },
    { id: "view", role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  const fit = new MenuItem({
    id: "sketchpad-fit",
    label: "Fit to canvas",
    enabled: false,
    click: () => {
      if (target && !window.isDestroyed())
        window.webContents.send("scope:sketchpad-menu-action", {
          tabId: target.tabId,
          action: "fit",
        });
    },
  });
  const view = menu.getMenuItemById("view")!.submenu!;
  view.insert(0, fit);
  view.insert(1, new MenuItem({ type: "separator" }));
  Menu.setApplicationMenu(menu);
  return (state: SketchpadMenuState) => {
    target = state;
    fit.enabled = state?.canFit ?? false;
  };
}
