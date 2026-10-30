import type { TabPlugin } from "../api.ts";
import { SessionsView } from "./view.tsx";

export const sessionsPlugin: TabPlugin = { type: "sessions", View: SessionsView };
