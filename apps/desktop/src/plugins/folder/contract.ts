import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  FolderPath,
  FolderRelativePath,
  MachineId,
  type FolderFeedEvent,
  type FolderIdentity,
  type FolderListing,
} from "@irudd-scope/protocol/folder";
import type { Tab } from "../../workspace/contract.ts";

export const FOLDER_TAB_TYPE = "folder";

/**
 * Saved Folder tab state, version 1. It holds no file names other than the expanded
 * folders and the selected file. `revision` counts changes made by desktop main, such as
 * an agent reopening the tab, so an older renderer save cannot undo them.
 */
export const FolderTabData = Schema.Struct({
  machineId: MachineId,
  path: FolderPath,
  expanded: Schema.Array(FolderRelativePath).check(Schema.isMaxLength(10_000)),
  filter: Schema.String.check(Schema.isMaxLength(1024)),
  showIgnored: Schema.Boolean,
  selectedPath: Schema.NullOr(FolderRelativePath),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type FolderTabData = typeof FolderTabData.Type;
export const FolderTabState = Schema.Struct({ version: Schema.Literal(1), data: FolderTabData });
export type FolderTabState = typeof FolderTabState.Type;
export const folderTabContract = { type: FOLDER_TAB_TYPE, version: 1, state: FolderTabState };

export function folderTabState(identity: FolderIdentity): FolderTabState {
  return {
    version: 1,
    data: {
      ...identity,
      expanded: [],
      filter: "",
      showIgnored: false,
      selectedPath: null,
      revision: 1,
    },
  };
}

/** The folder's own name, used as the title when the agent passes none. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return (parts.at(-1) ?? path).slice(0, 160) || "Folder";
}

/** Sent from main when an agent command creates, restores, unhides, or renames a Folder tab. */
export type FolderTabOpened = {
  tab: Tab;
  created: boolean;
  restored: boolean;
  unhidden: boolean;
};

/** Why a folder cannot be shown right now. */
export type FolderUnavailable = "offline" | "update" | "gone" | "missing" | "outside" | "error";
export type FolderListResult =
  | { status: "ok"; listing: FolderListing }
  | { status: FolderUnavailable; message: string };
/** Change feed events main sends to the open Folder tab. */
export type FolderViewEvent = {
  tabId: string;
  event: FolderFeedEvent | { type: "unavailable"; reason: FolderUnavailable; message: string };
};

/**
 * Applies a change desktop main made to a Folder tab to the renderer's copy. Main owns
 * the title, the folder, and the revision; the renderer keeps its own expanded folders,
 * filter, ignored-files setting, and selection. Visibility is handled by the workspace.
 */
export function mergeFolderTab(current: Tab, incoming: Tab): Tab {
  const mine = decode(FolderTabState, current.state).data;
  const theirs = decode(FolderTabState, incoming.state).data;
  return {
    ...current,
    title: incoming.title,
    state: {
      version: 1,
      data: {
        ...mine,
        machineId: theirs.machineId,
        path: theirs.path,
        revision: Math.max(mine.revision, theirs.revision),
      },
    },
  };
}
