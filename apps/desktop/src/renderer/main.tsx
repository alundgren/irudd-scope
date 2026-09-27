import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./workspace.tsx";
import "./style.css";
import type {} from "../bridge.ts";

window.EXCALIDRAW_ASSET_PATH = new URL("/", window.location.href).toString();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
