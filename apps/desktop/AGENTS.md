# Desktop ownership

Electron main owns artifact storage, desktop preferences, credentials, the
publishing API, and provider calls. Read [architecture](../../docs/architecture.md)
before changing these responsibilities.

- `src/main.ts` owns startup, the window, and shutdown after pending saves finish.
- `src/artifacts/` owns `scope.db`, HTTP publication, discovery, and library updates.
- `src/desktop-store.ts` owns `desktop.db`, including settings, workspace, and diagram drafts.
- `src/settings.ts` and `src/workspace.ts` define desktop preference contracts.
- `src/credentials.ts` owns Keychain and process-memory credential access.
- `src/diagram/` owns semantic operations, provider calls, and canvas conversion.
- `src/diagram/provider-settings.ts` owns the configured provider and model.
- `src/bridge.ts`, `src/preload.ts`, and `src/ipc.ts` define, expose, and handle named desktop operations.
- `src/renderer-security.ts` owns renderer content serving and access restrictions.
- `src/renderer/` owns UI. Read its local instructions before UI work.

Validate IPC input and callers in main. Keep credentials out of renderer
reads. Preserve cancellation and resource cleanup when changing lifecycle
code. HTML artifacts must remain isolated with scripts disabled.

Storage changes need existing-data validation. Tests for this app live in
`../../tests/`; use the relevant store tests and real Electron flows. Run
Node development commands through Vite+, but keep main compatible with
Electron's bundled runtime. Native Keychain checks require macOS.
