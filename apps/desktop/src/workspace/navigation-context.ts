import { createContext } from "react";

export const WorkspaceNavigationContext = createContext<{
  openMemoryTab: () => Promise<void>;
  openSavedTab: (tabId: string) => Promise<void>;
} | null>(null);
