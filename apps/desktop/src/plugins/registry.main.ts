import { registerPlanIpc } from "./plan/main.ts";
import { registerDiagramIpc } from "./diagram/main.ts";
import { registerPullRequestsIpc } from "./pull-requests/main.ts";
import type { MainPluginContext } from "./main-api.ts";

export function registerMainPlugins(context: MainPluginContext) {
  registerPlanIpc(context);
  const diagrams = registerDiagramIpc(context);
  const pullRequests = registerPullRequestsIpc(context);
  return {
    cancelPending: () => diagrams.cancelPending(),
    cancelPullRequests: () => pullRequests.cancelPending(),
    resumePullRequests: () => pullRequests.resume(),
    cancelTabs: (ids: string[]) => {
      diagrams.cancelTabs(ids);
      pullRequests.cancelTabs(ids);
    },
    dispose: () => pullRequests.dispose(),
  };
}
