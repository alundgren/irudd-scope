# Working in irudd-scope

Scope lets coding agents publish artifacts for a human to inspect in a Mac desktop app. The desktop owns persistent artifacts. Publishing requires Scope to be running on an awake Mac. The optional hub only forwards requests and fails when the desktop is unavailable. Agent observation is optional. Scope does not run coding sessions or orchestrate agents.

Read [architecture](docs/architecture.md) before changing ownership or dependencies, [development](docs/development.md) before running or validating code, and [ux.md](ux.md) before changing an interaction. The [visual prototype brief](docs/visual-prototype-brief.md) describes the intended desktop experience.

- Define contracts once in `packages/protocol`. Keep storage and transport details with their owner. Validate external input before use.
- Keep dependencies directed toward shared contracts. Desktop and CLI must not import hub internals. Split modules for actual responsibilities, not speculative reuse.
- Prefer direct code and small public APIs. Use Effect for validated contracts and work where explicit errors, cancellation, or resource ownership help.
- Run `vp run ready` successfully before completion and every push, including documentation changes. CI runs the same command. Do not install validation hooks.
- Test observable outcomes through real entry points. Standard tests must need no credentials, live models, or production data.
- Never commit credentials or publish personal artifacts. Provider keys belong to the desktop main process. Untrusted HTML must remain sandboxed with scripts disabled.
- Explain current behavior in durable docs. Keep work history and validation receipts out of source and architecture docs.
- Use direct names for the actual component, data, or behavior. Avoid abstract architectural metaphors. Do not use `seam`, `spine`, `shape`, `load-bearing`, or `blast radius` in new writing or identifiers, except required external names or literals.

Propose changes to recorded ownership, dependencies, or persisted contracts before implementing them. Routine implementation choices within these rules do not require approval.
