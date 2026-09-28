# Shared artifact protocol

Own artifact schemas, limits, discovery validation, and the HTTP client.
Keep this package independent of apps, filesystem operations, Electron, and
model providers. Desktop-only settings, drafts, and renderer IPC contracts stay in desktop. Public diagram operations and commands live in `src/diagram.ts`.

Derive types from Effect Schema and validate external input before use. Define
contracts once and keep [README.md](README.md) consistent with them. A change
to wire fields or persisted values needs an explicit compatibility decision.

Test protocol behavior through real publication and forwarding in
`../../tests/artifacts.test.ts`. Include rejected input and concurrent updates
when affected. Do not freeze private helper names or source layout in tests.
