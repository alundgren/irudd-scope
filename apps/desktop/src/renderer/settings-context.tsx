import { createContext } from "react";
import type { SettingsView } from "../settings.ts";

export const SettingsContext = createContext<{
  settings: SettingsView | undefined;
  openSettings: (query: string) => void;
} | null>(null);
