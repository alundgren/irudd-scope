import type { ComponentType } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { Tab, TabState } from "../workspace/contract.ts";
import type { Theme } from "../renderer/appearance.ts";
import type { TabEvents } from "./events.ts";

export type TabContext = {
  tabId: string;
  groupId: string;
  events: TabEvents;
  updateState: (state: TabState) => void;
  onBeforeClose: (save: () => Promise<void>) => () => void;
};
export type TabProps = {
  tab: Tab;
  context: TabContext;
  theme: Theme;
  focus: boolean;
  viewing: boolean;
  artifact?: Artifact;
};
export type CreatedTab = Pick<Tab, "type" | "title" | "state"> & { artifact?: Artifact };
export type PluginTool = {
  id: string;
  title: string;
  keywords: string;
  View: ComponentType<{ onCreated: (tab: CreatedTab) => void; onClose: () => void }>;
};
export type TabPlugin = {
  type: string;
  View: ComponentType<TabProps>;
  publication?: {
    accepts: (artifact: Artifact) => boolean;
    artifactId: (state: TabState) => string;
    state: (artifact: Artifact) => TabState;
  };
  tools?: readonly PluginTool[];
};
