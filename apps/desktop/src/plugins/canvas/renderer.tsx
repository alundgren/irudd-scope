import { LayoutDashboard } from "lucide-react";
import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { CANVAS_TAB_TYPE } from "./contract.ts";

const CanvasView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.CanvasView })),
);

export const canvasPlugin: TabPlugin = {
  type: CANVAS_TAB_TYPE,
  View: ({ tab, context, active, viewing }) => (
    <CanvasView tab={tab} context={context} active={active} viewing={viewing} />
  ),
  label: (tab) => ({
    title: tab.title,
    icon: LayoutDashboard,
    detail: "Canvas",
    tooltip: `${tab.title}\nCanvas`,
    keywords: "canvas whiteboard cards diagrams",
  }),
};
