import { lazy } from "react";
import type { TabPlugin } from "../api.ts";

const MeetingView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.MeetingView })),
);

export const meetingPlugin: TabPlugin = {
  type: "meeting",
  View: ({ tab, context, active }) => <MeetingView tab={tab} context={context} active={active} />,
};
