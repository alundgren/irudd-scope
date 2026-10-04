import { createContext } from "react";

export const WorkspaceNavigationContext = createContext<{
  openSavedTab: (tabId: string) => Promise<void>;
} | null>(null);
