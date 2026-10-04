import type { MemoryService } from "../memory.ts";
import type { DesktopStore } from "../desktop-store.ts";
import type { ScopeClient } from "@irudd-scope/protocol/client";

import type { ArtifactStore } from "../library/store.ts";
import type { Workspace } from "../workspace/contract.ts";

import type { BrowserWindow } from "electron";

export type MainPluginContext = {
  window: BrowserWindow;
  handle: (channel: string, action: (input: unknown) => unknown) => void;
  store: DesktopStore;
  artifacts: ArtifactStore;
  workspace: () => Promise<Workspace>;
  client: ScopeClient;
  memory: MemoryService;
};
