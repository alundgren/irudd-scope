import type { DesktopStore } from "../desktop-store.ts";
import type { ScopeClient } from "@irudd-scope/protocol/client";

export type MainPluginContext = {
  handle: (channel: string, action: (input: unknown) => unknown) => void;
  store: DesktopStore;
  client: ScopeClient;
};
