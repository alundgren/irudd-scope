import { promptsPlugin } from "./prompts/renderer.tsx";
import { memoryPlugin } from "./memory/renderer.tsx";
import type { Artifact } from "@irudd-scope/protocol";
import type { Tab } from "../workspace/contract.ts";
import { filePlugin } from "./file/renderer.tsx";
import { sketchpadPlugin } from "./sketchpad/renderer.tsx";
import { planPlugin } from "./plan/renderer.tsx";

import { pullRequestsPlugin } from "./pull-requests/renderer.tsx";
import { retroPlugin } from "./retro/renderer.tsx";

export const tabPlugins = [
  promptsPlugin,
  memoryPlugin,
  sketchpadPlugin,
  planPlugin,
  pullRequestsPlugin,
  retroPlugin,
  filePlugin,
];
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
