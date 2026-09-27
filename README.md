# irudd-scope

A private workspace where coding agents leave things for a human to inspect. A persistent hub stores artifacts on a VM, and an Electron app displays them on a Mac. Codex and Claude can publish through the same CLI.

The repository is public. The running hub belongs on a private tailnet.

## Development

Install Vite+ `1.0.0-rc.1`, then run:

```sh
vp install
vp run ready
```

The project pins Node and pnpm through Vite+. Linux supports development and testing. macOS is the desktop deployment target.

See [development and launch commands](docs/development.md), [architecture](docs/architecture.md), [protocol](packages/protocol/README.md), [technology choices and alternatives](docs/technology.md), and [UI decisions](ux.md). The [visual prototype brief](docs/visual-prototype-brief.md) is a self-contained task for a design agent.

MIT licensed.
