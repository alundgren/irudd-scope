import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { pullRequestsArtifactId, pullRequestsTabState } from "./contract.ts";
const View = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.PullRequestsView })),
);

export const pullRequestsPlugin: TabPlugin = {
  type: "pull-requests",
  View,
  publication: {
    accepts: (artifact) => artifact.kind === "pull-requests",
    artifactId: pullRequestsArtifactId,
    state: pullRequestsTabState,
  },
};
