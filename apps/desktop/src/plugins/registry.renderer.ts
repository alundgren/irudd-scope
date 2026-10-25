import { promptsPlugin } from "./prompts/renderer.tsx";
import { memoryPlugin } from "./memory/renderer.tsx";
import type { Artifact } from "@irudd-scope/protocol";
import type { Tab } from "../workspace/contract.ts";
import type { TabLabel, TabLabelContext } from "./api.ts";
import { filePlugin } from "./file/renderer.tsx";
import { sketchpadPlugin } from "./sketchpad/renderer.tsx";
import { planPlugin } from "./plan/renderer.tsx";

import { pullRequestsPlugin } from "./pull-requests/renderer.tsx";
import { retroPlugin } from "./retro/renderer.tsx";
import { folderPlugin } from "./folder/renderer.tsx";

export const tabPlugins = [
  promptsPlugin,
  memoryPlugin,
  sketchpadPlugin,
  planPlugin,
  pullRequestsPlugin,
  retroPlugin,
  folderPlugin,
  filePlugin,
];
export const findPlugin = (type: string) => tabPlugins.find((plugin) => plugin.type === type);
export function pluginForArtifact(artifact: Artifact) {
  return tabPlugins.find((plugin) => plugin.publication?.accepts(artifact))!;
}
/** A plugin's own label for a tab, or undefined to use the title. */
export function tabLabel(tab: Tab, context: TabLabelContext): TabLabel | undefined {
  try {
    return findPlugin(tab.type)?.label?.(tab, context);
  } catch {
    return undefined;
  }
}
export function tabArtifactId(tab: Tab): string | undefined {
  try {
    return findPlugin(tab.type)?.publication?.artifactId(tab.state);
  } catch {
    return undefined;
  }
}

/** Owner-aware view support is explicit; unsupported native kinds never use the file fallback. */
export function guestPlugin(kind: string) {
  return kind === "file"
    ? filePlugin
    : kind === "folder"
      ? folderPlugin
      : kind === "plan"
        ? planPlugin
        : undefined;
}
