# Working in irudd-scope

Scope lets coding agents publish artifacts for a human to inspect in a Mac desktop app. The desktop owns persistent artifacts. Direct publishing requires Scope to be running on an awake Mac. The optional paired hub forwards requests through a connection opened by the Mac and buffers opted-in publications while the desktop is offline. It persists configuration, credential hashes, up to 50 pending tabs, and up to 1,000 recently observed artifact metadata records in SQLite. Pending tabs and saved metadata expire after 48 hours. Saved revisions allow offline updates without overwriting newer desktop content. Delivered artifacts belong to the desktop. Scope does not run coding sessions or orchestrate agents.

## Work in the relevant area

Read the `AGENTS.md` files on the path to the files you change. Start searches
in the affected area and expand to callers and contracts as needed. Add local
instructions only when an area has distinct ownership or rules, and write
only what differs from its parents.

| Area                          | Responsibility                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| `apps/desktop/src/library/`   | Artifact HTTP API, discovery, and SQLite tab content storage.        |
| `apps/desktop/src/plugins/`   | Built-in tab views, state contracts, and main-process handlers.      |
| `apps/desktop/src/workspace/` | Tab lifecycle, groups, event routing, and workspace navigation.      |
| `apps/desktop/src/renderer/`  | Renderer startup, shared controls, settings, and design tokens.      |
| `apps/desktop/src/`           | Electron lifecycle, named IPC, desktop preferences, and credentials. |
| `apps/hub/`                   | Optional authenticated forwarding to the desktop.                    |
| `packages/cli/`               | File detection, provenance, and publication commands.                |
| `packages/sqlite/`            | SQLite shrinking and maintenance scheduling.                         |
| `packages/protocol/`          | Shared validated artifact contracts and HTTP client.                 |
| `tests/`                      | User journeys, integration tests, and synthetic fixtures.            |
| `tools/`                      | Development commands and test process setup.                         |

Read documents for the task that needs them:

- Names, ownership, dependencies, or persisted contracts: [architecture](docs/architecture.md).
- Setup, running code, dependencies, tests, lint, or format: [development](docs/development.md).
- Data locations, backup, or import compatibility: [storage](docs/storage.md).
- UI changes or review: the repo [UX guidance skill](.agents/skills/ux-guidance/SKILL.md), [UI decisions](ux.md), and [visual design](docs/visual-design.md).
- Artifact API changes: [protocol](packages/protocol/README.md).

These files contain the repository's rules. When available, use `code-guidance`
and `ux-design` as supporting house guidance. Scope's recorded UI choices take
precedence over house defaults. Use `gh` for GitHub work and load `github-use`
when available.

## Project rules

- Define shared artifact contracts once in `packages/protocol`. Desktop-only IPC, settings, and diagram contracts stay in desktop. Keep storage and transport details with their owner. Validate external input before use.
- Keep dependencies directed toward shared contracts. Desktop and CLI must not import hub internals. Split modules for actual responsibilities, not speculative reuse.
- Use the same domain names in folders, code, docs, and diagrams. Name modules for their data or work. Rename callers and documentation together; preserve compatibility for persisted fields and public commands.
- Prefer direct code and small public APIs. Use Effect for validated contracts and work where explicit errors, cancellation, or resource ownership help.
- Run `vp run ready` successfully before completion and every push, including documentation changes. CI runs the same command. Do not install validation hooks.
- Use Conventional Commit format for commit subjects and pull request titles: `type: description` or `type(scope): description`, for example `docs: require conventional commit titles`. Use `feat` for features, `fix` for bug fixes, and an appropriate type such as `docs`, `refactor`, `test`, `build`, `ci`, or `chore` for other changes. Mark breaking changes with `!` before the colon and explain them in the commit body and PR description. The PR title must describe the full change.
- Use Vite+ for development commands and package scripts: `vp install`, `vp add`, `vp run`, `vp exec node`, `vp exec`, and `vp dlx`. Do not substitute direct `node`, `npm`, `npx`, or `pnpm` commands where Vite+ supports the operation. A shipped executable's Node shebang and tests reusing `process.execPath` are runtime requirements, not development command alternatives.
- Test observable outcomes through real entry points. Standard tests must need no credentials, live models, or production data.
- Never commit credentials or publish personal artifacts. Provider keys belong to the desktop main process. Published HTML is trusted agent output; allow scripts, external resources, and browser interactions without an iframe sandbox or injected content policy.
- Persist Scope-owned data in SQLite, including artifact bytes, ordinary settings, and workspace preferences. Store Mac provider credentials directly in Keychain. The private CLI discovery file retains the publishing endpoint and token. Linux development credentials stay in memory. Do not add filesystem blob stores, JSON settings files, or renderer localStorage persistence. Explicit imports and exports remain files.
- Explain current behavior and necessary operating limits in durable docs. Put unimplemented proposals, work-item references, progress, and review evidence in issues or review artifacts outside tracked documentation. Do not keep prototype instructions or superseded alternatives beside current guidance.
- Comments explain non-obvious reasons or constraints. Do not narrate implementation work or repeat what the code does. Keep formatting choices in the formatter and lint configuration.
- Use direct names for the actual component, data, or behavior. Avoid abstract architectural metaphors. Do not use `seam`, `spine`, `shape`, `load-bearing`, or `blast radius` in new writing or identifiers, except required external names or literals.

Propose changes to recorded ownership, dependencies, or persisted contracts before implementing them. Routine implementation choices within these rules do not require approval.
