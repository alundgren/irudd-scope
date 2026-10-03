import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { planArtifactId, planTabState } from "./contract.ts";

const PlanView = lazy(() => import("./view.tsx").then((module) => ({ default: module.PlanView })));

export const planPlugin: TabPlugin = {
  type: "plan",
  publication: {
    accepts: (artifact) => artifact.kind === "plan",
    artifactId: planArtifactId,
    state: planTabState,
  },
  View: PlanView,
};
