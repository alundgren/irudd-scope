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
and type checking enabled. Plugin import restrictions are generated from the
built-in plugin directories. Plugins use shared APIs and event contracts;
only the registries compose their implementations. Non-semantic style choices
belong to these tools.
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
does not use Electron can also run directly with `vp test run tests/artifact-storage.test.ts`.
Passing Linux tests does not establish Mac signing, native Keychain access,
or live OpenRouter behavior. Validate those separately on their real platform
when changing the relevant integration. Keep validation results and screenshots
in review evidence, outside durable documentation.

For local performance measurements after building, run:

```sh
vp exec node tools/benchmark.ts --output /tmp/scope-benchmark.json
vp exec node tools/benchmark.ts --gpu --output /tmp/scope-benchmark-gpu.json
```

The benchmark uses synthetic content and an isolated desktop profile. It measures
built CLI calls, rendering, Electron CPU time, and process memory for all six
viewers, large files, many tabs, and restart. The default disables GPU acceleration
to match the test fixture; `--gpu` uses the app's normal graphics settings. Run
without concurrent builds or tests. Reports contain raw samples and measurement
definitions. Process memory sums RSS and can count shared pages more than once.
The benchmark is separate from `ready` and needs no provider key.

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

`get` returns metadata. Use Download in the desktop to save content. Install
the CLI from the installed app's Settings to use `irudd-scope` on PATH.
The checkout's built CLI is `packages/cli/dist/main.mjs`; its Node shebang
requires the configured Node runtime. For repeated agent calls, use that executable
or `./packages/cli/dist/main.mjs` directly. `vp run scope` invokes the source in
the checkout. Pass `--help` to the chosen command for options. The
[CLI skill](../.agents/skills/irudd-scope/SKILL.md) describes publication and recovery.

Publication returns a JSON record after storage commits. Rendering and diagram
generation in the desktop run independently of that receipt. The CLI publishes
finished files; it does not start model requests. Optional Git provenance has a
short time limit and stays absent if it cannot be collected.

CLI requests share a 10-second deadline, including uploads and response bodies.
Use `--timeout-ms 60000` for a slow remote transfer. If a command times out after
publication starts, check its artifact ID with `get` before retrying, since the
write may have committed without a receipt.

Scope writes its local endpoint and publishing token to a private discovery
file. The CLI reads it automatically. See [storage](storage.md) for file
locations, backup, and import behavior. Quitting Scope leaves the discovery
file in place but stops publication.

Open Settings from the search panel or Command-comma. The search button and
Command-K open workspace controls, current-tab actions, and artifact search.
Search also finds appearance and diagram generation settings. Appearance follows
System unless Light or Dark is selected. Diagram generation uses OpenRouter and Gemini 3.8
Flash. Add, replace, or remove its key in Settings. On macOS keys live in
Keychain; Linux development keeps them in memory.

Use Create diagram in the empty workspace or search panel. A
generated diagram becomes an editable artifact. Ask agent edits its current
canvas; Save publishes the edits. HTML previews permit inline styles and
embedded data images, with scripts and external resources blocked. Markdown
omits raw HTML and renders link labels and image descriptions as text.

## Installed app

The root [installer](../install.sh) runs on macOS with Apple's command line
tools. It clones `main`, installs frozen dependencies through Vite+, builds
the workspace, and packages the desktop on that Mac. Vite+ supplies the
pinned Node and package manager. Packaging includes the CLI and native Keychain
module, uses local ad-hoc signing, and checks that the packaged CLI, SQLite,
and native module can run. It needs no Apple developer certificate. This is
a local build, not an Apple-notarized distribution or a GitHub release build.

The installer defaults to these locations:

| Location                                            | Purpose                                           |
| --------------------------------------------------- | ------------------------------------------------- |
| `~/.local/share/irudd-scope/source`                 | Scope's managed Git clone and build dependencies. |
| `~/.local/share/irudd-scope/builds/<sha>/Scope.app` | Complete app for one commit.                      |
| `~/.local/share/irudd-scope/current`                | Link to the active build.                         |
| `~/.local/share/irudd-scope/previous`               | Previous active build retained for recovery.      |
| `~/.local/share/irudd-scope/prepared`               | Most recently prepared build.                     |
| `~/Applications/Scope.app`                          | Link to the active app.                           |
| `~/.local/bin/irudd-scope`                          | Optional CLI link installed from Settings.        |

`SCOPE_INSTALL_ROOT` and `SCOPE_APPLICATIONS_DIR` select other installation
and application directories. Both should be absolute paths writable by the
current user. `SCOPE_VP` selects an existing absolute Vite+ executable path.
The build records the installation root, Vite+ path, and commit in the app
bundle so Finder launches can update without a terminal's PATH.

Every installed-app startup checks `origin`'s `main` SHA. Unchanged commits
need no dependency installation or build. A changed commit builds in a separate
directory while the current app stays usable. Restart to update flushes
workspace and draft writes before selecting the prepared app and relaunching.
If saving fails, Keep open leaves the current version active. Settings shows
build output, cancellation, and retry. Update preparation has a 20-minute
deadline; an interrupted build can be retried. Quitting stops build processes.
Old builds are removed on startup, retaining the running, previous, and
prepared versions. Development launches never auto-update.

Keep personal changes in a separate checkout. The installer refuses to
overwrite edits in its managed clone or replace an unrelated `Scope.app`.
A failed fetch or build leaves the active app in place. If a process was
forcibly killed and no installation is still running, remove the
`.install-lock` directory under the installation root before retrying.
Re-running the installer reuses a completed build for the same commit.

The CLI install button creates its link and adds `~/.local/bin` to the login
profile for zsh or bash. It preserves existing commands at that path. Open a
new terminal to pick up PATH changes. Other shells need `~/.local/bin` added
to PATH manually. The launcher uses Electron's bundled Node runtime; no
separate Node installation is needed to publish.

The skill button uses Vite+ to run the [skills CLI](https://skills.sh/docs/cli)
with `npx`, installing only `irudd-scope` from this repository globally for
Codex and Claude Code. Update skill repeats that scoped installation. Skills
do not update automatically with the app. Installation needs network access;
errors remain visible with a retry through the same button.

Use Remove CLI and Remove skill in Settings to undo those installations.
The shared PATH entry stays in the shell profile. To remove the app, quit it
and delete its link in `~/Applications` and its installation directory.
The artifact library, preferences, Keychain entry, and discovery file live
separately and remain intact. See [storage](storage.md) before restoring an
older app, since its database support may differ.

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

Install the standalone CLI on the remote with the root `install-cli.sh`. It
builds only the CLI and hub packages, copies the managed Node runtime into
the installation, and links `~/.local/bin/irudd-scope`. It does not install
the desktop. Linux and macOS can install the CLI; managed hub setup currently
requires Linux, a working systemd user service manager, and user lingering.
Tailscale must already be installed and connected, with permission to configure
Serve. Setup reports missing prerequisites before changing the service.

```sh
irudd-scope setup
irudd-scope pair
irudd-scope hub status
```

Setup shows the paths and private endpoint before confirmation. `--yes`
accepts that plan for unattended use, and `--no-pair` suppresses generating a
pairing link. `--port` chooses the loopback listener; `--https-port` chooses
the private Serve port. By default setup finds an unused HTTPS port starting
at 8450 and avoids loopback ports already targeted by other Serve routes.
It reuses saved ports on later runs, preserves existing routes, and refuses
an occupied explicit port. Remove a configured hub before changing its ports.
If user lingering is disabled, enable it with `loginctl enable-linger USER`
and retry. If Serve needs HTTPS enabled or additional permission, follow its
reported setup instructions and rerun `irudd-scope setup`.

Setup installs the bundled publishing skill in `~/.agents/skills/irudd-scope`
and links it for Claude Code. These links follow the standalone CLI's current
build. Existing unrelated skills or CLI commands are never replaced. Use
`irudd-scope skill install` or `irudd-scope skill remove` independently.

Paste the pairing URL into Settings → Remotes in Scope. The secret is in the
URL fragment. Links expire after ten minutes; generating another invalidates
the previous link. A successful pairing exchanges it for a connection token
stored in Mac Keychain. The hub stores credential hashes in SQLite. Each hub
pairs with one Mac. Use `irudd-scope hub unpair` before pairing another Mac.

The Mac opens all relay connections through the remote's Tailscale Serve
endpoint. The hub only binds to loopback. A tailnet rule permitting Mac-to-remote
HTTPS is sufficient; remote-to-Mac initiation is unnecessary. CLI publication
uses its private local discovery file without endpoint flags. The hub streams
active requests and keeps no offline queue. Scope must be open on an awake Mac.

Enabled remotes reconnect automatically while Scope runs. Disconnect remains
off until Connect is selected. Remove remote revokes the hub credential;
if the hub is unreachable, reconnect it and retry removal. `irudd-scope hub
stop` and `start` control the user service. `hub remove` revokes access and
removes only its service and Serve route, preserving the CLI, skill, and
settings. It requires the hub to be running. Logs are available through
`journalctl --user -u irudd-scope-hub.service`.

Re-run the standalone installer to update its payload, then run setup to
restart the hub with the new version. Completed builds live in
`~/.local/share/irudd-scope-cli/builds`; `current` and `previous` select builds.
`SCOPE_CLI_INSTALL_ROOT`, `SCOPE_CLI_BIN_DIR`, and `SCOPE_VP` override installer
paths. `SCOPE_CLI_SOURCE` builds an existing absolute checkout without fetching
or changing it. `SCOPE_HUB_DATA_DIR` and `SCOPE_CONNECTION_FILE` select private
hub state and discovery locations. `SCOPE_SETUP_HOME` selects a separate home
directory for skill and user-service installation during isolated verification.

To remove the CLI after removing the hub, delete its managed link and installation
directory. Remove the skill first if it should not remain. The shared PATH entry
in the shell profile remains. Hub data locations and recovery are in
[storage](storage.md).

### Direct HTTPS access

Direct desktop access and the original forwarding mode remain available when
your tailnet permits callers to initiate connections to the Mac.

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
