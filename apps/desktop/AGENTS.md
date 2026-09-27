# Desktop ownership

Electron main owns artifact storage, desktop preferences, credentials, the
publishing API, and provider calls. Read [architecture](../../docs/architecture.md)
before changing these responsibilities.

- `src/main.ts` owns startup, the window, and shutdown after pending saves finish.
- `src/library/` owns `scope.db`, HTTP publication, discovery, and library updates.
- `src/lifecycle.ts` coordinates tab creation, closing, and legacy imports. Tab records, content references, metadata, and drafts share `scope.db` with foreign keys and cascading deletion.
- `src/desktop-store.ts` owns `desktop.db`, including settings, workspace groups, and selection.
- `src/settings.ts` defines desktop settings; `src/workspace/contract.ts` defines tabs and groups.
- `src/workspace/` owns navigation, tab lifecycle, event routing, and saved workspace updates.
- `src/plugins/` owns built-in tab implementations and their explicit registrations.
  Each plugin keeps its UI, contracts, and main handlers together.
- `src/credentials.ts` owns Keychain and process-memory credential access.
- `src/remotes.ts` owns pairing, Mac-initiated relay connections, and cancellation.
- `src/bridge.ts`, `src/preload.ts`, and `src/ipc.ts` expose named desktop operations
  and validate callers. Plugin main entries register their own operations.
- `src/renderer-security.ts` owns renderer content serving and access restrictions.
- `src/renderer/` owns startup, shared UI controls, settings, and theme tokens.

Read the local instructions in the workspace, plugin, library, or renderer
area before changing it. Renderer files can live beside their plugin's main
files, but may import only renderer code and process-independent contracts.

Validate IPC input and callers in main. Keep credentials out of renderer
reads. Preserve cancellation and resource cleanup when changing lifecycle
code. HTML artifacts must remain isolated with scripts disabled.

Storage changes need existing-data validation. Tests for this app live in
`../../tests/`; use the relevant store tests and real Electron flows. Run
Node development commands through Vite+, but keep main compatible with
Electron's bundled runtime. Native Keychain checks require macOS.
