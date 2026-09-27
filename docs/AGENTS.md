# Current documentation

Each document owns one kind of information:

- `architecture.md`: component ownership, dependencies, domain names, and data flow.
- `development.md`: setup, commands, tests, lint, format, and runtime configuration.
- `storage.md`: data locations, backup, recovery, and supported imports.
- `technology.md`: installed technologies and their practical costs.
- `visual-design.md`: current desktop controls and token usage.
- Root `ux.md`: settled product behavior and reasons for house-style exceptions.
- `packages/protocol/README.md`: the public artifact API beside its contracts.

Verify behavior against code before documenting it. Keep version numbers in
manifests and visual values in `tokens.css`; link to those owners. Record
actionable limitations without promising an implementation. Supported data
imports and downgrade restrictions are operating instructions, not a project
journal.

Keep proposals, work-item references, review receipts, rejected alternatives,
and prototype assets outside tracked guidance. Do not add a separate agent
or human document when both audiences need the same instructions. Check local
links after moving files. Documentation changes still require `vp run ready`.
