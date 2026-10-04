# Workspace host

`contract.ts` owns tabs, groups, and saved workspace validation. A tab UUID is
independent of its content ID. Every open tab references a saved
group UUID; the owner reference does not depend on an open tab.

`use-workspace.ts` owns opening, selection, closing, groups, and state
updates. `workspace.tsx` composes navigation, library search, and registered
plugin tools. `tab-host.tsx` mounts registered views and contains tab errors.
Keep views mounted through tab switches, focus, and dialogs.

`events.ts` routes validated events to other open tabs in the same group and
to host subscribers. Derive membership from the workspace, clean up closed
tab subscriptions, and isolate listener failures. The main-process bridge
validates the saved sender and group. Events are not persisted or replayed.

`persistence.ts` flushes pending writes before the window closes. Closing a
temporary tab flushes saves and moves it to Trashcan. Closing a permanent tab
hides it from the strip, moves it to the end of the saved workspace order, and
selects another visible tab when available. Hidden tabs stay mounted and reopen
from the drawer with their saved UUID and position. Built-in plugin categories
are always permanent and close by hiding; they cannot enter Trashcan. Explicit
trash actions flush saves for ordinary temporary and permanent tabs. Failed saves or trash
writes keep the tab visible for retry. `retention.ts` owns desktop retention
contracts; `use-tab-retention.ts` reports visibility and requests cleanup after
saves. Permanent deletion removes tab content atomically. Late saves only update existing tabs. Preserve open
IDs, order, selection, groups, and unavailable plugin records in migrations.

Read the [UX skill](../../../../.agents/skills/ux-guidance/SKILL.md) for UI
changes. Test workspace behavior through real Electron, including keyboard
navigation, both appearances, and close/restart with drafts.
