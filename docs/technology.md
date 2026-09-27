# Technology

Scope uses TypeScript across the CLI, forwarding hub, Electron main process,
and React renderer. The [workspace catalog](../pnpm-workspace.yaml) pins direct
dependencies. The [lockfile](../pnpm-lock.yaml) records the resolved dependency
tree. Runtime and package manager versions belong in [package.json](../package.json).

| Component     | Technology and reason                                                                                           | Cost or constraint                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Development   | Vite+ manages installs, builds, Vitest, formatting, lint, and type checks.                                      | Vite+ and Effect use pinned release candidates.                                                                                                |
| Desktop       | Electron hosts React and Excalidraw on macOS and Linux.                                                         | Chromium adds download size and memory use. Main uses Electron's bundled Node runtime.                                                         |
| Contracts     | Effect Schema validates external input and derives TypeScript types.                                            | Callers must decode input at the receiving boundary; TypeScript alone cannot validate it.                                                      |
| Storage       | SQLite through `@effect/sql-sqlite-node` in Electron main. Each store owns its Effect runtime and transactions. | One writer per database; content reads allocate up to the artifact size limit.                                                                 |
| Credentials   | `@napi-rs/keyring` accesses macOS Keychain from main.                                                           | Native packaging and Keychain access require Mac validation. Linux development uses process memory.                                            |
| Publication   | Node HTTP, authenticated requests, and SSE notifications.                                                       | Scope must be awake and running. Notifications have no durable replay.                                                                         |
| Remote access | Private HTTPS, normally Tailscale Serve, directly or through the forwarding hub.                                | Callers need private network access and the publishing token.                                                                                  |
| Controls      | Local shadcn components with Base UI, Tailwind, Lucide icons, and Scope tokens.                                 | The repo owns component styling and upgrades.                                                                                                  |
| Reading       | `react-markdown`, raster image previews, and sandboxed static HTML.                                             | Markdown links and images are rendered as text. HTML scripts and external resources are blocked.                                               |
| Diagrams      | Lazy-loaded Excalidraw with validated drawing operations.                                                       | The editor is a substantial browser dependency. Its drawing formats and fonts remain separate from Scope controls.                             |
| Generation    | OpenRouter HTTP calls from main, using the model defined in desktop settings.                                   | Calls need a configured key and network access. Responses are validated before the canvas changes.                                             |
| Validation    | Vite+'s Vitest and Playwright controlling real Electron.                                                        | Linux needs Electron's shared libraries and a display or Xvfb. Synthetic responses do not establish live provider or native Keychain behavior. |

See [architecture](architecture.md) for ownership and [development](development.md)
for commands. Scope runs from a checkout; the repository has no application
packaging or release workflow.
