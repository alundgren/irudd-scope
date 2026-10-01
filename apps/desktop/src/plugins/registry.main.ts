import { registerPlanIpc } from "./plan/main.ts";
import { registerDiagramIpc } from "./diagram/main.ts";
import type { MainPluginContext } from "./main-api.ts";

export function registerMainPlugins(context: MainPluginContext) {
  registerPlanIpc(context);
  return registerDiagramIpc(context);
}
