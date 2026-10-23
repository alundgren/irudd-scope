import { lazy } from "react";
import { decode } from "@irudd-scope/protocol";
import type { TabPlugin } from "../api.ts";
import { localMachineName } from "../../renderer/remote-names.ts";
import { FOLDER_TAB_TYPE, FolderTabState, folderName } from "./contract.ts";

const FolderView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.FolderView })),
);

export const folderPlugin: TabPlugin = {
  type: FOLDER_TAB_TYPE,
  View: ({ tab, context, active }) => <FolderView tab={tab} context={context} active={active} />,
  label(tab, { remoteName, platform }) {
    const { machineId, path } = decode(FolderTabState, tab.state).data;
    const machine = machineId === "local" ? undefined : (remoteName(machineId) ?? "Removed remote");
    const name = folderName(path);
    return {
      title: tab.title,
      ...(machine ? { machine } : {}),
      detail: machine ? `${machine} · ${name}` : name,
      tooltip: `${tab.title}\n${machine ?? localMachineName(platform)}\n${path}`,
      keywords: `${machine ?? ""} ${name}`,
    };
  },
};
