import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { pullRequestsArtifactId, pullRequestsTabState } from "./contract.ts";
const View = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.PullRequestsView })),
);
const Create = lazy(() =>
  import("./create.tsx").then((module) => ({ default: module.CreatePullRequests })),
);
export const pullRequestsPlugin: TabPlugin = {
  type: "pull-requests",
  View,
  publication: {
    accepts: (artifact) => artifact.kind === "pull-requests",
    artifactId: pullRequestsArtifactId,
    state: pullRequestsTabState,
  },
  tools: [
    {
      id: "create-pull-requests",
      title: "Create PR inbox",
      keywords: "create pull requests github repository inbox",
      View: ({ onCreated, onClose }) => (
        <Create
          onClose={onClose}
          onCreated={(artifact) =>
            onCreated({
              type: "pull-requests",
              title: artifact.title,
              state: pullRequestsTabState(artifact),
              artifact,
            })
          }
        />
      ),
    },
  ],
};
