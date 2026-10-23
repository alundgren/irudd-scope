# Folder file access

This package owns every file system operation behind Folder tabs, on the
desktop for local folders and on the hub for remote folders. Wire contracts
live in `packages/protocol/src/folder.ts`; keep storage, HTTP, and Electron
out of this package.

- Resolve real paths and keep every read, listing, and watch inside the
  canonical root. Symlinks that leave the root are listed but never followed.
- Scope never edits, renames, or deletes files in a shared folder. The only
  write copies dropped files in with `writeFolderFile`: staged as
  `.scope-partial-*`, checked again, and committed by rename or hard link.
  It never writes through a link and removes the staged file on failure.
- Never watch, list, or search through `.git`. Ignored folders are not watched,
  and search reads them only when ignored files are shown.
- Open files and folders with `openInside`. On Linux it checks the opened handle's
  kernel path in `/proc/self/fd`, which is exact. macOS and Windows have no Node API
  for a handle's path, so it checks successive observations instead: every folder
  from the root is still a real directory and the entry still matches the handle's
  device and inode. That is not atomic; a folder swapped for a link and swapped back
  between two of those checks could pass. Remote folders are served by Linux hubs.

Test through the CLI, the hub's file routes, and the desktop's IPC handlers in
`../../tests/folder-*.test.ts`.
