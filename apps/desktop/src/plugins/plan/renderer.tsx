import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { planArtifactId, planTabState } from "./contract.ts";

const PlanView = lazy(() => import("./view.tsx").then((module) => ({ default: module.PlanView })));
const CreatePlan = lazy(() =>
  import("./create.tsx").then((module) => ({ default: module.CreatePlan })),
);

export const planPlugin: TabPlugin = {
  type: "plan",
  publication: {
    accepts: (artifact) => artifact.kind === "plan",
    artifactId: planArtifactId,
    state: planTabState,
  },
  View: PlanView,
  tools: [
    {
      id: "create-plan",
      title: "Create plan",
      keywords: "create plan planning html review feedback",
      View: ({ onCreated, onClose }) => (
        <CreatePlan
          onClose={onClose}
          onCreated={(artifact) =>
            onCreated({
              type: "plan",
              title: artifact.title,
              state: planTabState(artifact),
              artifact,
            })
          }
        />
      ),
    },
  ],
};
