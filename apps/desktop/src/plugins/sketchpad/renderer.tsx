import { lazy } from "react";
import type { TabPlugin } from "../api.ts";

const SketchpadView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.SketchpadView })),
);

export const sketchpadPlugin: TabPlugin = {
  type: "sketchpad",
  View: ({ context, theme, viewing, active }) => (
    <SketchpadView context={context} theme={theme} viewing={viewing} active={active} />
  ),
};
