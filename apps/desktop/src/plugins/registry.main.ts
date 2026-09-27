import { registerDiagramIpc } from "./diagram/main.ts";
import type { MainPluginContext } from "./main-api.ts";

export function registerMainPlugins(context: MainPluginContext) {
  return registerDiagramIpc(context);
}
