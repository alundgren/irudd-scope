import type { Artifact } from "@irudd-scope/protocol";
import type { Tab } from "../workspace/contract.ts";
import { filePlugin } from "./file/renderer.tsx";
import { diagramPlugin } from "./diagram/renderer.tsx";

export const tabPlugins = [diagramPlugin, filePlugin];
export const pluginTools = tabPlugins.flatMap((plugin) => plugin.tools ?? []);
export const findPlugin = (type: string) => tabPlugins.find((plugin) => plugin.type === type);
export function pluginForArtifact(artifact: Artifact) {
  return tabPlugins.find((plugin) => plugin.publication?.accepts(artifact))!;
}
export function tabArtifactId(tab: Tab): string | undefined {
  try {
    return findPlugin(tab.type)?.publication?.artifactId(tab.state);
  } catch {
    return undefined;
  }
}
