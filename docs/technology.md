# Technology

Scope uses TypeScript across the CLI, forwarding hub, Electron main process,
and React renderer. The [workspace catalog](../pnpm-workspace.yaml) pins direct
dependencies. The [lockfile](../pnpm-lock.yaml) records the resolved dependency
tree. Runtime and package manager versions belong in [package.json](../package.json).

| Component     | Technology and reason                                                                                                                      | Cost or constraint                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Development   | Vite+ manages installs, builds, Vitest, formatting, lint, and type checks.                                                                 | Vite+ and Effect use pinned release candidates.                                                                                                |
| Desktop       | Electron hosts React and Excalidraw on macOS and Linux.                                                                                    | Chromium adds download size and memory use. Main uses Electron's bundled Node runtime.                                                         |
| Installation  | Git and Vite+ build a managed local clone; `@electron/packager` creates the Mac app.                                                       | Installation needs Apple's command line tools and disk space for dependencies and retained app builds. New main commits build locally.         |
| Contracts     | Effect Schema validates external input and derives TypeScript types.                                                                       | Callers must decode input at the receiving boundary; TypeScript alone cannot validate it.                                                      |
| Storage       | SQLite through `@effect/sql-sqlite-node` in Electron main; `node:sqlite` stores hub configuration and credential hashes.                   | One writer per database; content reads allocate up to the artifact size limit.                                                                 |
| Credentials   | `@napi-rs/keyring` accesses macOS Keychain from main.                                                                                      | Native packaging and Keychain access require Mac validation. Linux development uses process memory.                                            |
| Publication   | Node HTTP, authenticated requests, and SSE notifications.                                                                                  | Scope must be awake and running. Notifications have no durable replay.                                                                         |
| Remote access | The Mac opens streaming HTTPS relay connections through Tailscale Serve on each paired hub.                                                | The hub needs Linux user-service support for managed setup. Publication requires an awake Mac running Scope.                                   |
| Controls      | Local shadcn components with Base UI, Tailwind, Lucide icons, and Scope tokens.                                                            | The repo owns component styling and upgrades.                                                                                                  |
| Reading       | `react-markdown`, raster image previews, and interactive HTML documents.                                                                   | HTML is trusted agent output with normal browser behavior. Markdown links and images are rendered as text.                                     |
| Diagrams      | Lazy-loaded Excalidraw with validated diagram operations.                                                                                  | The editor is a substantial browser dependency. Its document format and fonts remain separate from Scope controls.                             |
| Generation    | OpenRouter HTTP calls from main, using the model in [diagram provider settings](../apps/desktop/src/plugins/diagram/provider-settings.ts). | Calls need a configured key and network access. Responses are validated before the canvas changes.                                             |
| Validation    | Vite+'s Vitest and Playwright controlling real Electron.                                                                                   | Linux needs Electron's shared libraries and a display or Xvfb. Synthetic responses do not establish live provider or native Keychain behavior. |

See [architecture](architecture.md) for ownership and [development](development.md)
for commands. Installed apps build their updates locally. Development launches
run from a checkout; there is no GitHub release build workflow.
