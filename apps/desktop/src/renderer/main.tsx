import { startDiagramCommands } from "../plugins/diagram/command-renderer.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../workspace/workspace.tsx";
import "./style.css";
import type {} from "../bridge.ts";

window.EXCALIDRAW_ASSET_PATH = new URL("/", window.location.href).toString();

startDiagramCommands();

const initialSettings = await window.scope.settings().catch(() => undefined);
const appearance = initialSettings?.appearance ?? "system";
document.documentElement.dataset.theme =
  appearance === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : appearance;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App initialSettings={initialSettings} />
  </StrictMode>,
);
