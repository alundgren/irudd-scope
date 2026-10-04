import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { retroArtifactId, retroTabState } from "./contract.ts";

const RetroView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.RetroView })),
);
export const retroPlugin: TabPlugin = {
  type: "retro",
  publication: {
    accepts: (artifact) => artifact.kind === "retro",
    artifactId: retroArtifactId,
    state: retroTabState,
  },
  View: RetroView,
};
