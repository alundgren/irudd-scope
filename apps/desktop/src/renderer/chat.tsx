import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "../plugins/canvas/chat/panel.tsx";
import "./style.css";
import "../plugins/canvas/chat/style.css";

// The panel takes its colors from the workspace page beside it.
window.scopeChat.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatPanel />
  </StrictMode>,
);
