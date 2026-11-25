import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { githubWorkspaceArtifactId, githubWorkspaceTabState } from "./contract.ts";

const View = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.GitHubWorkspaceTabView })),
);

export const githubWorkspacePlugin: TabPlugin = {
  type: "github-workspace",
  View,
  publication: {
    accepts: (artifact) => artifact.kind === "github-workspace",
    artifactId: githubWorkspaceArtifactId,
    state: githubWorkspaceTabState,
  },
};
