# Development

Install Vite+ at the version pinned in the [workspace catalog](../pnpm-workspace.yaml).
[package.json](../package.json) pins Node and pnpm; Vite+ provisions them.
Use `vp install`, `vp add`, `vp run`, `vp exec`, and `vp dlx` for development.
Run Node scripts through `vp exec node`. Electron main must also work with
Electron's bundled Node runtime, which is separate from the development runtime.

```sh
vp install --frozen-lockfile
vp run ready
```

Direct dependencies use exact catalog versions. Vite+ and Effect use pinned
release candidates; other dependencies use stable releases. Alpha, beta,
nightly, and canary versions require a specific project decision. Update
manifests, catalog, and lockfile together through Vite+.

## Validation and tests

`vp run ready` builds the CLI, hub, and desktop, runs `vp check`, then runs the
tests. [CI](../.github/workflows/check.yml) uses that same command. It must pass
before completion and every push, including documentation changes. Validation
does not rewrite source or the lockfile. Do not install validation hooks.

Vite+ owns formatting, lint, and TypeScript checks through
[vite.config.ts](../vite.config.ts). Formatting uses Oxfmt defaults. Lint uses
Oxlint's defaults plus the rule requiring Vite+ imports, with type-aware lint
and type checking enabled. Non-semantic style choices belong to these tools.
Apply corrections explicitly with `vp check --fix`, inspect the diff, then
run `vp run ready` again. Naming, ownership, and documentation accuracy remain
review responsibilities.

Tests import from `vite-plus/test`. Prefer tests in this order:

1. User outcomes through the built CLI and real Electron.
2. Integration tests for storage, forwarding, provider responses, and failures.
3. Pure unit tests where isolated rules need focused evidence.

Derive expected results from intended behavior and contracts. Verify what
users can observe, such as content after restart or preserved edits after a
conflict. Avoid assertions about private helper calls, file lists, incidental
ordering, or today's output alone. Do not duplicate every assertion at each
level. Test counts and coverage percentages are not goals.

Keep tests and small synthetic fixtures in `tests/`, where publication tests
can exercise multiple owners. Name tests for the responsibility they verify.
Use temporary data directories, isolated discovery files, ephemeral ports,
and synthetic provider responses. Standard tests need no credentials, live
models, or production data. Cleanup must close processes and databases and
remove temporary data. Do not add application tests for prose-only edits;
inspect changed text, links, and formatting instead.

Linux Electron tests need a display and shared libraries. On Ubuntu install
`xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64`. The test
runner resolves Electron before starting workers and starts Xvfb when no
display is available. Dependency downloads belong to setup; an uninstalled
Electron binary can be downloaded by its package during initialization.

After building, use focused checks while investigating a change:

```sh
vp run build
vp check
vp run test tests/desktop.test.ts
vp run test tests/artifacts.test.ts
```

The test runner supplies the display environment for Electron. A test that
does not use Electron can also run directly with `vp test run tests/storage.test.ts`.
Passing Linux tests does not establish Mac signing, native Keychain access,
or live OpenRouter behavior. Validate those separately on their real platform
when changing the relevant integration. Keep validation results and screenshots
in review evidence, outside durable documentation.

## Run locally

`vp run desktop` builds and opens Electron. Main starts the local publishing
API and opens SQLite. No hub process or connection form is needed. The Mac
must stay awake with Scope open to accept publication.

With Scope open, publish synthetic content from another terminal:

```sh
vp run scope text "The retry loop needs a bound." --title "Finding" --id finding
vp run scope add report.md --title "Review" --id review
vp run scope add screenshot.png --title "Layout"
vp run scope add preview.html --title "Preview"
vp run scope add build.zip --title "Build output"
vp run scope add architecture.excalidraw --title "Architecture" --id architecture
vp run scope update architecture architecture-v2.excalidraw
vp run scope list
vp run scope get architecture
```

`get` returns metadata. Use Download in the desktop to save content. The built
CLI is `packages/cli/dist/main.mjs`; its Node shebang is the runtime entry
point. A wrapper or symlink named `irudd-scope` can put it on PATH when the
configured Node runtime is available. `vp run scope` invokes the source in
the checkout. `vp run scope --help` lists options.

Scope writes its local endpoint and publishing token to a private discovery
file. The CLI reads it automatically. See [storage](storage.md) for file
locations, backup, and import behavior. Quitting Scope leaves the discovery
file in place but stops publication.

Open Settings from the workspace menu or Command-comma. Search finds
appearance and diagram generation settings. Appearance follows System unless
Light or Dark is selected. Diagram generation uses OpenRouter and Gemini 3.8
Flash. Add, replace, or remove its key in Settings. On macOS keys live in
Keychain; Linux development keeps them in memory.

Use Create diagram in the empty workspace, search, or workspace menu. A
generated diagram becomes an editable artifact. Ask agent edits its current
canvas; Save publishes the edits. HTML previews permit inline styles and
embedded data images, with scripts and external resources blocked. Markdown
omits raw HTML and renders link labels and image descriptions as text.

Scope runs from a checkout. There is no signed Mac bundle or release workflow.

## Isolated development

Use separate data and discovery paths when running multiple desktop instances.
The desktop and its CLI must use the same discovery file.

| Variable                      | Meaning                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `SCOPE_DESKTOP_DATA_DIR`      | Electron profile containing `desktop.db`.                                                         |
| `SCOPE_DATA_DIR`              | Artifact directory containing `scope.db`; defaults to `artifacts` under the profile.              |
| `SCOPE_CONNECTION_FILE`       | Private CLI discovery file.                                                                       |
| `SCOPE_PORT`                  | Loopback publishing port, default `43120`. Use `0` for an OS-assigned port recorded in discovery. |
| `SCOPE_SESSION_CREDENTIALS=1` | Keep provider keys in memory on a development Mac. Standard Electron tests set this.              |

## Remote access

Expose the Mac's loopback API through Tailscale Serve on an unused private
HTTPS port, preserving existing routes:

```sh
tailscale serve --bg --https=8450 http://127.0.0.1:43120
```

The remote CLI uses `SCOPE_ENDPOINT=https://your-mac.your-tailnet.ts.net:8450`
and the publishing token through `SCOPE_TOKEN_FILE` or `SCOPE_TOKEN`.
`--endpoint` and `--token-file` are equivalent CLI overrides. Transfer tokens
privately and keep them outside Git. An explicit endpoint disables automatic
local discovery and requires explicit credentials.

The optional hub uses a private environment file with `SCOPE_ENDPOINT`
pointing to the Mac's HTTPS endpoint and `SCOPE_TOKEN` containing the same
publishing token. `SCOPE_PORT` selects its loopback port, default `43120`.
After building:

```sh
vp exec node --env-file=/path/to/private/hub.env apps/hub/dist/main.mjs
```

Use Tailscale Serve for private access to that listener when needed. The hub
has no database, content directory, queue, or replay. It returns 503 when it
cannot reach the desktop before sending response headers; interrupted streams
close. Both paths require an awake Mac running Scope. Do not expose either
listener through a public listener or funnel. Provider keys belong only to
desktop main.
