# Built-in tab plugins

Each plugin directory owns its views, state contracts, and optional main-process
handlers. Add entries to `registry.ts`, `registry.renderer.ts`, and, when needed,
`registry.main.ts`. Keep the existing file viewers together in `file/`.

- Import shared contracts, library operations, and renderer controls directly.
  Plugins must not import another plugin's implementation. Only registries
  compose plugins. Lint enforces this for the registered plugin directories.
- Keep state contracts free of React, Electron, storage, and provider imports.
  Renderer entries import renderer code; main entries import main code.
- Use `TabContext.events` for communication with sibling tabs. Define the
  event contract in `events.ts`, describe domain activity, and let the host
  attach tab and group IDs. Subscriptions need cleanup. Events are transient;
  load current data when opening a tab.
- Main handlers use the validated IPC registration supplied by the host.
  Keep credentials and database connections in main. Durable state goes
  through desktop persistence, with validation and a migration when it changes.
- Read the [UX skill](../../../../.agents/skills/ux-guidance/SKILL.md) for UI
  changes. Reuse `../renderer/components/ui/` and `../renderer/tokens.css`.
  Preserve mounted views during navigation, and flush edits before close.

Test a plugin through real Electron with synthetic content. Shared lifecycle,
group isolation, and storage behavior also have focused tests in `tests/`.
