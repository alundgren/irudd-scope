import { registerPromptsIpc, initializePromptsTab } from "./prompts/main.ts";
import type { DesktopLifecycle } from "../lifecycle.ts";
import { registerMemoryIpc } from "./memory/main.ts";
import { registerRetroIpc } from "./retro/main.ts";
import { registerPlanIpc } from "./plan/main.ts";
import { registerSketchpadIpc } from "./sketchpad/main.ts";
import { registerPullRequestsIpc } from "./pull-requests/main.ts";
import type { MainPluginContext } from "./main-api.ts";

export function registerMainPlugins(context: MainPluginContext) {
  registerPromptsIpc(context);
  registerMemoryIpc(context);
  registerPlanIpc(context);
  const retros = registerRetroIpc(context);
  registerSketchpadIpc(context);
  const pullRequests = registerPullRequestsIpc(context);
  return {
    cancelPullRequests: () => pullRequests.cancelPending(),
    resumePullRequests: () => pullRequests.resume(),
    cancelTabs: (ids: string[]) => pullRequests.cancelTabs(ids),
    dispose: () => {
      retros.dispose();
      pullRequests.dispose();
    },
  };
}

export async function initializeBuiltinPlugins(lifecycle: DesktopLifecycle) {
  await initializePromptsTab(lifecycle);
}
