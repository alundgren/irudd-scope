import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { workspaceArtifactId, workspaceTabState } from "./contract.ts";

const View = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.WorkspaceTabView })),
);

export const workspacePlugin: TabPlugin = {
  type: "workspace",
  View,
  publication: {
    accepts: (artifact) => artifact.kind === "workspace",
    artifactId: workspaceArtifactId,
    state: workspaceTabState,
  },
};
