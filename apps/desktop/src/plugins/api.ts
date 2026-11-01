import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { Artifact } from "@irudd-scope/protocol";
import type {
  OverlayName,
  OverlayPosition,
  Tab,
  TabState,
  WorkspaceFlushPurpose,
} from "../workspace/contract.ts";
import type { Theme } from "../renderer/appearance.ts";
import type { TabEvents } from "./events.ts";

export type TabContext = {
  tabId: string;
  groupId: string;
  events: TabEvents;
  updateState: (state: TabState) => void;
  updateOverlayPosition: (name: OverlayName, position: OverlayPosition | undefined) => void;
  onBeforeClose: (save: (purpose: WorkspaceFlushPurpose) => Promise<void>) => () => void;
  /** Closes this tab the way the strip's close button does. */
  close: () => void;
};
/** How the strip, tooltip, and drawer describe a tab that is not a publication. */
export type TabLabel = {
  title: string;
  /** Shown before the title in the strip, so the tab's kind is visible at a glance. */
  icon?: LucideIcon;
  /** Shown first in the accent colour, and never cut when the title is shortened. */
  machine?: string;
  /** The drawer's second line. */
  detail: string;
  tooltip: string;
  /** Extra text the drawer search matches. */
  keywords: string;
};
export type TabLabelContext = { remoteName: (id: string) => string | undefined; platform: string };
export type TabProps = {
  active: boolean;
  tab: Tab;
  context: TabContext;
  theme: Theme;
  focus: boolean;
  viewing: boolean;
  artifact?: Artifact;
};
export type TabPlugin = {
  type: string;
  View: ComponentType<TabProps>;
  label?: (tab: Tab, context: TabLabelContext) => TabLabel;
  publication?: {
    accepts: (artifact: Artifact) => boolean;
    artifactId: (state: TabState) => string;
    state: (artifact: Artifact) => TabState;
  };
};
