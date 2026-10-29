import type { TabPlugin } from "../api.ts";
import { HarnessesView } from "./view.tsx";

export const harnessesPlugin: TabPlugin = { type: "harnesses", View: HarnessesView };
