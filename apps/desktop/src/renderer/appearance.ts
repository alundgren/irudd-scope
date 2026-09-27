import { useEffect, useState } from "react";
import type { SettingsView } from "../settings.ts";

export type Appearance = SettingsView["appearance"];
export type Theme = "light" | "dark";

export function useAppearance(initial: Appearance) {
  const [appearance, setAppearance] = useState(initial);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme: Theme = appearance === "system" ? (systemDark ? "dark" : "light") : appearance;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    changed();
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return { appearance, theme, setAppearance };
}
