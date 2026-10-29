import { registerPromptsIpc, initializePromptsTab } from "./prompts/main.ts";
import type { DesktopLifecycle } from "../lifecycle.ts";
import { registerMemoryIpc } from "./memory/main.ts";
import { registerRetroIpc } from "./retro/main.ts";
import { registerPlanIpc } from "./plan/main.ts";
import { registerSketchpadIpc } from "./sketchpad/main.ts";
import { registerPullRequestsIpc } from "./pull-requests/main.ts";
import type { MainPluginContext } from "./main-api.ts";
import { registerFolderIpc } from "./folder/main.ts";
import { registerHarnessesIpc } from "./harnesses/main.ts";

export function registerMainPlugins(context: MainPluginContext) {
  registerPromptsIpc(context);
  registerMemoryIpc(context);
  registerPlanIpc(context);
  const retros = registerRetroIpc(context);
  registerSketchpadIpc(context);
  registerHarnessesIpc(context);
  const pullRequests = registerPullRequestsIpc(context);
  const folders = registerFolderIpc(context);
  return {
    folderCommand: folders.command,
    watchFolder: folders.watch,
    cancelPullRequests: () => pullRequests.cancelPending(),
    resumePullRequests: () => pullRequests.resume(),
    cancelTabs: (ids: string[]) => {
      pullRequests.cancelTabs(ids);
      folders.cancelTabs(ids);
    },
    hiddenTabs: (ids: string[]) => folders.tabsClosed(ids),
    dispose: () => {
      folders.dispose();
      retros.dispose();
      pullRequests.dispose();
    },
  };
}

export async function initializeBuiltinPlugins(lifecycle: DesktopLifecycle) {
  await initializePromptsTab(lifecycle);
}
