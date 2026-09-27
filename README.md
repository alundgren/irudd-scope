<img src="apps/desktop/resources/icon.png" alt="Scope, an open window with a blue breeze" width="96" height="96" />

# irudd-scope

A private workspace where coding agents leave things for a human to inspect. An Electron app stores and displays artifacts on the Mac. Local publishing works while Scope is open, without a VM. An optional hub forwards remote requests and fails when the Mac is unavailable. Codex and Claude can publish through the same CLI.

The repository is public. Artifact data and credentials stay private. Remote access belongs on a private tailnet.

SQLite stores artifact contents, metadata, ordinary settings, and workspace preferences. Mac provider credentials live directly in Keychain. The private discovery file holds the CLI publishing token. Artifacts stay on the Mac; publishing requires Scope to be running.

## Development

Install Vite+ `1.0.0-rc.1`, then run:

```sh
vp install
vp run ready
```

The project pins Node and pnpm through Vite+. Linux supports development and testing. macOS is the desktop deployment target.

See [development and launch commands](docs/development.md), [architecture](docs/architecture.md), [protocol](packages/protocol/README.md), [technology choices and alternatives](docs/technology.md), and [UI decisions](ux.md). The [visual reference](docs/excalidraw-style-study.md) shows the selected design. Use the repo [UX guidance skill](.agents/skills/ux-guidance/SKILL.md) for UI work.

MIT licensed.
