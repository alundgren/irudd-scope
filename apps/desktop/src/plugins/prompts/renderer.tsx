import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
const PromptsView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.PromptsView })),
);
export const promptsPlugin: TabPlugin = { type: "prompts", View: PromptsView };
