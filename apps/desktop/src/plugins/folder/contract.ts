import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  FolderLines,
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
  /** Lines an agent marked in the selected file. Selecting another file clears them. */
  selectedLines: Schema.optionalKey(Schema.NullOr(FolderLines)),
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

/** The folders that contain a file, outermost first. */
export function folderAncestors(file: string): string[] {
  const parts = file.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * A file an agent selected with `folder select`, whether the folder's ignore rules hide
 * it, and the lines the agent marked in it.
 */
export type FolderSelection = { file: string; ignored: boolean; lines?: FolderLines };

/**
 * A Folder tab's data after an agent selects a file: every folder down to it is expanded,
 * and ignored files are shown when the file is one.
 */
export function selectFolderFile(data: FolderTabData, selection: FolderSelection): FolderTabData {
  return {
    ...data,
    expanded: [...new Set([...data.expanded, ...folderAncestors(selection.file)])],
    showIgnored: data.showIgnored || selection.ignored,
    selectedPath: selection.file,
    selectedLines: selection.lines ?? null,
  };
}

/**
 * Sent from main when an agent command creates, restores, unhides, or renames a Folder
 * tab, or selects a file in it with `folder select`.
 */
export type FolderTabOpened = {
  tab: Tab;
  created: boolean;
  restored: boolean;
  unhidden: boolean;
  selected?: FolderSelection;
};

/** Why a folder cannot be shown right now. */
export type FolderUnavailable = "offline" | "update" | "gone" | "missing" | "outside" | "error";
export type FolderListResult =
  | { status: "ok"; listing: FolderListing }
  | { status: FolderUnavailable; message: string };
/** A file whose path matches the filter text. */
export type FolderNameMatch = { path: string; ignored: boolean };
/**
 * Where the filter's matches come from: the path list while it is built or once it is
 * ready, or the folder's machine when the folder has too many paths to list.
 */
export type FolderPathsState = "scanning" | "ready" | "machine" | "failed";
export type FolderFilterResult =
  | { status: "ok"; state: FolderPathsState; matches: FolderNameMatch[]; truncated: boolean }
  | { status: FolderUnavailable; message: string };
export type FolderSearchMatch = { path: string; line: number; text: string };
export type FolderSearchResult =
  | { status: "ok"; matches: FolderSearchMatch[]; truncated: boolean; cancelled: boolean }
  | { status: FolderUnavailable; message: string };
/** Change feed events main sends to the open Folder tab. */
export type FolderViewEvent = {
  tabId: string;
  event:
    | FolderFeedEvent
    | { type: "unavailable"; reason: FolderUnavailable; message: string }
    /** The tab's path list changed; an open filter asks again. */
    | { type: "paths"; state: FolderPathsState };
};

/**
 * Applies a change desktop main made to a Folder tab to the renderer's copy. Main owns
 * the title, the folder, and the revision; the renderer keeps its own expanded folders,
 * filter, ignored-files setting, and selection, except that a file an agent selected
 * replaces the selection and expands its folders. Visibility is handled by the workspace.
 */
export function mergeFolderTab(current: Tab, incoming: Tab, selected?: FolderSelection): Tab {
  const mine = decode(FolderTabState, current.state).data;
  const theirs = decode(FolderTabState, incoming.state).data;
  const merged: FolderTabData = {
    ...mine,
    machineId: theirs.machineId,
    path: theirs.path,
    revision: Math.max(mine.revision, theirs.revision),
  };
  return {
    ...current,
    title: incoming.title,
    state: {
      version: 1,
      data: selected === undefined ? merged : selectFolderFile(merged, selected),
    },
  };
}

/** A dropped item whose name exists, or matches an earlier dropped item. */
export type FolderDropClash = { id: string; path: string };
/**
 * Files dropped on a Folder tab, read on this computer and checked against the folder.
 * Nothing is written until `start`, which takes a choice for each clash by its `id`.
 */
export type FolderDropPlan =
  | { status: "ok"; planId: string; files: number; bytes: number; clashes: FolderDropClash[] }
  | { status: "failed"; message: string };
/** What to do with a dropped file whose name already exists. */
export type FolderDropChoice = "replace" | "keep";
export type FolderDropResult = {
  /** Folder-relative paths written by this run, in drop order. */
  written: string[];
  /** The written paths that are empty folders. */
  directories: string[];
  /** Items whose names appeared while the files were copied; ask again before writing them. */
  clashes: FolderDropClash[];
  cancelled: boolean;
  failed?: string;
};
/** A save or drop in progress, sent from main as it runs. */
export type FolderTransfer = {
  id: string;
  tabId: string;
  kind: "save" | "drop";
  name: string;
  done: number;
  total: number;
  state: "running" | "done" | "cancelled" | "failed";
  message?: string;
};
