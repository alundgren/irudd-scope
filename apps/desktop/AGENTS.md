# Desktop ownership

Electron main owns artifact storage, desktop preferences, credentials, the
publishing API, and provider calls. Read [architecture](../../docs/architecture.md)
before changing these responsibilities.

- `src/artifacts/` owns `scope.db`, HTTP publication, and discovery.
- `src/settings.ts` owns `desktop.db`, including workspace and diagram drafts.
- `src/credentials.ts` owns Keychain and process-memory credential access.
- `src/diagram/` owns semantic operations, provider calls, and canvas conversion.
- `src/bridge.ts` and `src/preload.ts` expose named desktop operations.
- `src/renderer/` owns UI. Read its local instructions before UI work.

Validate IPC input and callers in main. Keep credentials out of renderer
reads. Preserve cancellation and resource cleanup when changing lifecycle
code. HTML artifacts must remain isolated with scripts disabled.

Storage changes need existing-data validation. Tests for this app live in
`../../tests/`; use the relevant store tests and real Electron flows. Run
Node development commands through Vite+, but keep main compatible with
Electron's bundled runtime. Native Keychain checks require macOS.
