import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { SqliteClient } from "@effect/sql-sqlite-node";
import { decode } from "@irudd-scope/protocol";
import type { FolderIdentity } from "@irudd-scope/protocol/folder";
import { Tab } from "../workspace/contract.ts";
import {
  FOLDER_TAB_TYPE,
  FolderTabState,
  folderName,
  folderTabState,
  selectFolderFile,
  type FolderSelection,
  type FolderTabOpened,
} from "../plugins/folder/contract.ts";

export const createFolderTabs = (sql: SqliteClient.SqliteClient) =>
  sql`CREATE TABLE IF NOT EXISTS folder_tabs (
    machine_id TEXT NOT NULL, path TEXT NOT NULL,
    tab_id TEXT NOT NULL UNIQUE REFERENCES live_tabs(id) ON DELETE CASCADE,
    PRIMARY KEY(machine_id, path)
  ) STRICT`;

function folderRevision(tab: Tab): number | undefined {
  if (tab.type !== FOLDER_TAB_TYPE) return undefined;
  try {
    return decode(FolderTabState, tab.state).data.revision;
  } catch {
    return undefined;
  }
}

/** Whether a renderer write would replace newer changes desktop main made to a Folder tab. */
export function staleFolderTab(saved: Tab, incoming: Tab): boolean {
  const savedRevision = folderRevision(saved);
  const incomingRevision = folderRevision(incoming);
  return savedRevision !== undefined && (incomingRevision ?? 0) < savedRevision;
}

/**
 * The one tab for a folder. It is open while it is in the tab strip: neither in Trashcan
 * nor closed to the drawer.
 */
export function findFolderTab(sql: SqliteClient.SqliteClient, identity: FolderIdentity) {
  return Effect.map(
    sql<{
      id: string;
      document: string;
      trashed_at: number | null;
    }>`SELECT live_tabs.id, live_tabs.document, live_tabs.trashed_at FROM folder_tabs JOIN live_tabs ON live_tabs.id = folder_tabs.tab_id WHERE folder_tabs.machine_id = ${identity.machineId} AND folder_tabs.path = ${identity.path} AND live_tabs.document IS NOT NULL`,
    ([row]) =>
      row && {
        tabId: row.id,
        open: row.trashed_at === null && !decode(Tab, JSON.parse(row.document)).hidden,
      },
  );
}

/**
 * Opens the one tab for a folder in a single transaction: creates it, restores it from
 * Trashcan, unhides it, or renames it. Restored and unhidden tabs move to the end of the strip.
 * With `select`, the tab also selects that file and expands the folders down to it.
 */
export function openFolderTab(
  sql: SqliteClient.SqliteClient,
  input: FolderIdentity & {
    title?: string;
    select?: FolderSelection;
    groupId: string;
    now: number;
  },
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const [row] = yield* sql<{
        id: string;
        document: string;
        trashed_at: number | null;
      }>`SELECT live_tabs.id, live_tabs.document, live_tabs.trashed_at FROM folder_tabs JOIN live_tabs ON live_tabs.id = folder_tabs.tab_id WHERE folder_tabs.machine_id = ${input.machineId} AND folder_tabs.path = ${input.path} AND live_tabs.document IS NOT NULL`;
      const selected = input.select === undefined ? {} : { selected: input.select };
      if (!row) {
        const state = folderTabState({ machineId: input.machineId, path: input.path });
        const tab: Tab = {
          id: randomUUID(),
          groupId: input.groupId,
          type: FOLDER_TAB_TYPE,
          title: input.title ?? folderName(input.path),
          state:
            input.select === undefined
              ? state
              : { ...state, data: selectFolderFile(state.data, input.select) },
        };
        yield* sql`INSERT INTO live_tabs(id, artifact_id, opened, document, position, created_at, last_visible_at)
          VALUES (${tab.id}, NULL, 1, ${JSON.stringify(tab)}, (SELECT coalesce(max(position), -1) + 1 FROM live_tabs), ${input.now}, ${input.now})`;
        yield* sql`INSERT INTO folder_tabs(machine_id, path, tab_id) VALUES (${input.machineId}, ${input.path}, ${tab.id})`;
        return {
          tab,
          created: true,
          restored: false,
          unhidden: false,
          ...selected,
        } satisfies FolderTabOpened;
      }
      const { hidden, ...saved } = decode(Tab, JSON.parse(row.document));
      const state = decode(FolderTabState, saved.state);
      const restored = row.trashed_at !== null;
      const unhidden = Boolean(hidden) && !restored;
      const title = input.title ?? saved.title;
      if (!restored && !hidden && title === saved.title && input.select === undefined)
        return { tab: saved, created: false, restored, unhidden } satisfies FolderTabOpened;
      const data =
        input.select === undefined ? state.data : selectFolderFile(state.data, input.select);
      const tab: Tab = {
        ...saved,
        title,
        state: { ...state, data: { ...data, revision: state.data.revision + 1 } },
      };
      if (restored || hidden)
        yield* sql`UPDATE live_tabs SET document = ${JSON.stringify(tab)}, trashed_at = NULL, last_visible_at = ${input.now}, position = (SELECT coalesce(max(position), -1) + 1 FROM live_tabs) WHERE id = ${row.id}`;
      else yield* sql`UPDATE live_tabs SET document = ${JSON.stringify(tab)} WHERE id = ${row.id}`;
      return { tab, created: false, restored, unhidden, ...selected } satisfies FolderTabOpened;
    }),
  );
}
