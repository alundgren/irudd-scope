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

`vp run ready` builds the CLI, hub, sharing service, and desktop, runs `vp run check`, then runs
the tests. The check script verifies formatting, lint, and types with compact
lint diagnostics. [CI](../.github/workflows/check.yml) uses that same command. It must pass
on the finished changes before completion and every push, including the first
push and documentation changes. Further edits require another successful run
before completion or pushing. CI after a push does not replace this local check.
Validation does not rewrite source or the lockfile. Do not install validation hooks.
The suite runs test files sequentially. The Electron pressure tests already
launch multiple competing publishers.

Keep successful tests quiet. The minimal reporter prints totals without listing
passing tests and shows console logs only for failures. The display runner also
holds Xvfb diagnostics unless the run fails. For detailed investigation, use
`vp run test --reporter=verbose --silent=false`.
Preserve failed exit codes and useful failure diagnostics. Keep successful
validation output brief and distinguish meaningful advisories from failed checks.

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

Oxlint warns when cyclomatic complexity exceeds 10, a JavaScript or TypeScript
file exceeds 500 lines, or a function exceeds 150 lines. Line counts exclude
blank and comment-only lines. These are review prompts and never fail the
standard checks. Required lint errors, type errors, and formatting failures
still fail. Keep unreviewed advisories visible and separate from failures; do not add
`--quiet`, `--deny-warnings`, or a warning limit to the standard check.

Simplify when it improves understanding. Keep related code together when
splitting would add indirection. Generated code, state machines, and complete
test scenarios can justify a warning. Explain material retained complexity in
the PR's Evidence section. Do not split code or suppress findings just to lower
a count. The thresholds belong in `vite.config.ts`.

The standard check uses [tools/lint-exceptions.ts](../tools/lint-exceptions.ts)
to omit reviewed advisories from its compact report. Each entry records the
exact file, rule limits, and reason for keeping that code together. Function
entries also name unique, trimmed source lines starting at the diagnostic.
The anchor follows line-number changes and distinguishes anonymous callbacks.
Only warnings from these three advisory rules can match an exception.

Review the function or file before adding an entry. Set each limit to the
reviewed count and explain why a refactor would not help. Increased counts,
new functions, other warnings, and errors remain visible. Remove an entry
when its warning disappears; the check reports unused or ambiguous entries.
An anchor change requires checking the entry against the new code. Do not
refresh the registry automatically, widen limits without review, or disable
rules for entire directories. Review still applies to behavior changes within
an existing count limit. The report prints one total for accepted advisories;
Oxlint's exit status remains unchanged.

Use `vp run check` for the reviewed report, `vp lint --format=unix` for all raw
lint and type diagnostics, or `vp check` when source context helps investigate
a finding. Direct Vite+ commands do not apply the exception registry.

Tests import from `vite-plus/test`. Prefer tests in this order:

1. Complete outcomes through actual entry points: the built CLI, real Electron
   flows, or a library's public API.
2. Integration or component tests for collaborating parts and useful failures.
3. Unit tests for isolated logic where that is the useful place to verify it.

Derive expected results from requirements, domain facts, and intended contracts. Verify what
users can observe, such as content after restart or preserved edits after a
conflict. Regression tests protect those contracts, not private helper calls,
source layout, incidental ordering, or today's output alone. A harmless refactor
should not require widespread test rewrites. Files, ordering, and command arguments
are valid assertions when the requirement depends on them, such as preserving
unrelated installations or selecting only the requested skill and agents.

Use real collaborating components where practical and isolate external systems
for repeatable standard checks. A UI test with replaced IPC handlers establishes
renderer behavior; it does not prove the real installation or update flow.
Add focused tests when they catch meaningful failures or improve diagnosis.
Do not duplicate every assertion at each level. Test counts and coverage
percentages are not goals.

Keep tests and small synthetic fixtures in `tests/`, where publication tests
can exercise multiple owners. Name tests for the responsibility they verify.
Use temporary data directories, isolated discovery files, ephemeral ports,
and synthetic provider responses. Standard tests need no credentials, live
models, or production data. Cleanup must close processes and databases and
remove temporary data. Do not add application tests for prose-only edits;
inspect changed text, links, and formatting instead.

Choose additional evidence for the change's claims, such as the benchmark below
for performance work. State what the evidence establishes and its limits in the
PR. Passing standard checks does not replace the requested behavior.

Linux Electron tests need a display and shared libraries. On Ubuntu install
`xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64`. The test
runner resolves Electron before starting workers and starts Xvfb when no
display is available. Dependency downloads belong to setup; an uninstalled
Electron binary can be downloaded by its package during initialization.

After building, use focused checks while investigating a change:

```sh
vp run build
vp run check
vp run test tests/desktop.test.ts
vp run test tests/artifacts.test.ts
```

The test runner supplies the display environment for Electron. A test that
does not use Electron can also run directly with `vp test run tests/artifact-storage.test.ts`.
Passing Linux tests does not establish Mac signing, native Keychain access,
or live OpenRouter behavior. Validate those separately on their real platform
when changing the relevant integration. `vp run check:credentials` verifies the
native credential helper on macOS with temporary signing certificates, an
isolated Keychain, and synthetic credentials. It checks unchanged helper access
across different signed callers, existing credential access, rejected callers,
and locked-Keychain failures, and reports read latency and helper memory use.
It temporarily adds the test Keychain to the search list for signing, then
removes it and deletes its files. `SCOPE_CREDENTIALS_KEYCHAIN` selects that
isolated Keychain and disables helper permission dialogs during verification.
Keep validation results and screenshots
in review evidence, outside durable documentation.

Electron tests keep Mac windows and Dock icons hidden by default. Hidden windows
disable background throttling so UI timers continue running. Linux test windows
remain visible because Chromium stalls CSS animations in hidden windows, which
prevents dialogs from closing and restoring focus. The runner uses Xvfb when no
display is available. Tests run the real main process, renderer, IPC, and database
operations. Unexpected native dialogs fail tests with diagnostics instead of
waiting for someone to dismiss them. Use
`SCOPE_TEST_SHOW_WINDOWS=1 vp run test tests/workspace.test.ts` to show Mac windows
and allow native dialogs during manual checks. Installed apps are unaffected.

### Lifecycle pressure test

After building, run `vp run test tests/lifecycle-pressure.test.ts --maxWorkers=1`.
The standard test uses generated content, a temporary desktop profile, and a
paired hub on loopback. Four publishers, two direct and two through the hub,
exercise all six artifact kinds, shared bytes, 120 publications with
tab overflow, drafts, and restart. It then runs two
12-artifact create/update/delete cycles. It verifies content bytes, deletion,
database integrity, empty content tables, and physical reclamation in all three
databases. `tests/tab-open.test.ts` holds real IPC requests before and after
opening to check deletion and recreation races and unrelated error reporting.

For a longer run through the built CLI, with 1,600 creates, updates, and deletes
in addition to warm-up and overflow checks:

```sh
SCOPE_PRESSURE_CYCLES=20 SCOPE_PRESSURE_COUNT=80 SCOPE_PRESSURE_KIB=64 \
SCOPE_PRESSURE_CLI=1 SCOPE_PRESSURE_SETTLE_MS=2000 \
SCOPE_PRESSURE_OUTPUT=/tmp/scope-pressure.json \
vp run test tests/lifecycle-pressure.test.ts --maxWorkers=1
```

Run memory measurements without concurrent builds or other tests. The optional
report records phase timings, main/WAL/shared-memory file sizes, allocated disk
space, Electron RSS, and macOS physical footprint. RSS can count shared pages more than
once. Physical-footprint sampling uses `python3` and macOS `proc_pid_rusage`;
Linux reports RSS. Memory samples support comparison between runs, without a
machine-dependent pass threshold. `SCOPE_PRESSURE_SETTLE_MS` sets the quiet
period between cycle phases, defaulting to two seconds when reporting and zero
otherwise. Reports omit hostnames, endpoints, credentials, and local paths.

The test uses no installed profile, Keychain entries, real remote host, or
provider. Its temporary pairing credentials live in memory, so it pairs again
after restart. The local hub exercises forwarding; it does not reproduce a
physical network's latency or outages. Temporary profiles and processes are
removed even when assertions fail.

### Performance measurements

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
Flash. Enable it in Settings → Diagram generation, then add its key. It is off
by default, including for existing profiles. On macOS keys live in Keychain;
Linux development keeps them in memory. Scope reads the provider key for a
generation request or when that enabled section opens. Saving or removing a
key also accesses Keychain. Startup and other settings changes do not read it.
Turning generation off retains the saved key. Enabled remotes still access
their Keychain credentials when connecting at startup.

Use Create diagram in the empty workspace or search panel. A
generated diagram becomes an editable artifact. Ask agent edits its current
canvas; edits save automatically. The diagram's left menu provides Export,
Find on canvas, and Library. HTML previews run trusted agent output with
scripts, external styles, images, fonts, network requests, forms, and popups.
Publish a complete HTML document. Resources must be embedded or use reachable
URLs; publishing a file does not upload adjacent files. A document can set its
own base URL. Normal browser rules such as CORS still apply. Markdown
omits raw HTML and renders link labels and image descriptions as text.

## Installed app

The root [installer](../install.sh) runs on macOS with Apple's command line
tools. It clones `main`, installs frozen dependencies through Vite+, builds
the workspace, and packages the desktop on that Mac. Vite+ supplies the
pinned Node and package manager. Packaging includes the CLI and native Keychain
module, defaults to local ad-hoc signing, and checks that the packaged CLI, SQLite,
and native module can run. It needs no Apple developer certificate. This is
a local build, not an Apple-notarized distribution or a GitHub release build.

The installer defaults to these locations:

| Location                                              | Purpose                                           |
| ----------------------------------------------------- | ------------------------------------------------- |
| `~/.local/share/irudd-scope/source`                   | Scope's managed Git clone and build dependencies. |
| `~/.local/share/irudd-scope/builds/<build>/Scope.app` | Complete app for one commit and signing identity. |
| `~/.local/share/irudd-scope/current`                  | Link to the active build.                         |
| `~/.local/share/irudd-scope/previous`                 | Previous active build retained for recovery.      |
| `~/.local/share/irudd-scope/prepared`                 | Most recently prepared build.                     |
| `~/.local/share/irudd-scope/application`              | Link recording the installed app's location.      |
| `~/Applications/Scope.app`                            | Complete app bundle for Finder and Spotlight.     |
| `~/.local/bin/irudd-scope`                            | Optional CLI link installed from Settings.        |

`SCOPE_INSTALL_ROOT` and `SCOPE_APPLICATIONS_DIR` select other installation
and application directories. Both should be absolute paths writable by the
current user. Keep the application directory outside the installation root.
Updates reuse the application location recorded during installation.
`SCOPE_VP` selects an existing absolute Vite+ executable path.
The build records the installation root, Vite+ path, commit, and optional
signing certificate fingerprint in the app bundle so Finder launches can
update without a terminal's PATH. Ad-hoc build directory names are commit
SHAs. Certificate-signed builds append `-<fingerprint>` to the SHA. Changing
signers can therefore package the same commit without changing a running build.

Every installed-app startup checks `origin`'s `main` SHA. Unchanged commits
need no dependency installation or build unless you change the signing identity.
A changed commit builds in a separate
directory while the current app stays usable. Restart to update flushes
workspace and draft writes before replacing the Applications bundle and
relaunching it. The replacement is copied in full before the installed app
is moved, and activation errors restore the previous app and build links.
If saving fails, Keep open leaves the current version active. Settings shows
build output, cancellation, and retry. Update preparation has a 20-minute
deadline; an interrupted build can be retried. Quitting stops build processes.
Old builds are removed on startup, retaining the running, previous, and
prepared versions. This retains one previous version for recovery, not a
history of every update. The Applications bundle uses a copy-on-write clone
where the filesystem supports it. Temporary replacement copies are removed
after activation. Development launches never auto-update.

Keep personal changes in a separate checkout. The installer refuses to
overwrite edits in its managed clone or replace an unrelated `Scope.app`.
A failed fetch or build leaves the active app in place. If a process was
forcibly killed and no installation is still running, remove the
`.install-lock` directory under the installation root before retrying.
The same applies to `.activation-lock` if a bundle replacement was forcibly
interrupted. If automatic restoration fails, the error reports where the
previous app was retained for recovery.
Re-running the installer reuses a completed build for the same commit.
It also replaces the older managed `~/Applications/Scope.app` symlink with
a complete bundle. Activation asks Spotlight to index the installed app;
search results may take a moment to refresh. Indexing failure does not undo
an otherwise successful installation.

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
and delete `~/Applications/Scope.app` and its installation directory.
The artifact library, preferences, Keychain entry, and discovery file live
separately and remain intact. See [storage](storage.md) before restoring an
older app, since its database support may differ.

### Optional local signing

Scope works without a signing certificate. Its default ad-hoc signature can
change with each build, so macOS may ask again before letting an updated app
read saved Keychain credentials. A self-signed certificate alone does not
prevent this: macOS also checks the executable's build hash. Certificate-signed
Scope installations use a small, separately signed credential helper that
stays unchanged across ordinary app updates. The helper accepts requests only
from Scope signed with the same certificate and uses the existing Keychain
entry. It runs only for credential operations and exits afterward.
This does not notarize the app or provide
Developer ID signing for distribution. See [Apple's code-signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).

Open **Settings → Signing certificate**. **How to create a certificate** has
these instructions and an **Open Keychain Access** button. Create the
certificate once on each Mac:

1. Open **Keychain Access** and select **login** in the left sidebar.
2. In the Mac menu bar at the top of the screen, choose **Keychain Access →
   Certificate Assistant → Create a Certificate…** Certificate Assistant is
   a menu item, not a separate app or a control inside the window.
3. Name it **Scope Local Signing**, select **Self Signed Root** as the
   identity type and **Code Signing** as the certificate type, then create
   it in the login keychain. Keep the certificate and its private key there
   for future builds. [Apple's certificate creation instructions](https://support.apple.com/guide/keychain-access/kyca8916/mac).
4. Return to Scope, paste **Scope Local Signing** in **Certificate name or
   fingerprint**, and click **Connect certificate**.
5. Scope prepares a signed copy. Click **Restart to apply** when ready.

Scope resolves the exact certificate name to its fingerprint. If several
certificates have the same name, paste the certificate's SHA-1 fingerprint
from Keychain Access instead. A missing certificate leaves the current app
in place and shows an error in Settings.

Connecting rebuilds the current commit, or the update already prepared for
restart. The running app keeps its existing identity until you restart.
Build progress includes cancellation and error details. **Disconnect
certificate** prepares a copy with default ad-hoc signing; it does not delete
anything from Keychain. You can cancel a prepared certificate change before
restarting.

For a terminal installation, run `security find-identity -p codesigning`
and copy the 40-character hexadecimal fingerprint beside the certificate's
name. Pass it to the installer, replacing the placeholder below:

```sh
curl -fsSL https://raw.githubusercontent.com/alundgren/irudd-scope/main/install.sh |
  SCOPE_SIGNING_IDENTITY='YOUR_40_CHARACTER_CERTIFICATE_FINGERPRINT' bash
```

The installer also accepts `SCOPE_SIGNING_IDENTITY` when run from a local
checkout. It stores only the fingerprint in the app's installation metadata;
the private key stays in Keychain. Later installer runs reuse the selected
identity when the variable is omitted. Automatic updates use the identity
recorded in the running app. Opting in works even when that commit was already
installed with ad-hoc signing.

macOS may ask for permission to use the certificate's private key during
signing. When the credential helper first accesses saved credentials, macOS may
ask you to approve **Scope Credentials**. Choose **Always Allow** to remember
that permission. Existing provider keys and remote tokens stay in the same
Keychain entry. Later ordinary updates reuse the verified helper, retaining
its approval. A change to the helper itself or its signing certificate can
require another approval. It does not unlock a locked keychain or override
other access restrictions. Failed helper access remains an error; Scope does
not silently switch credential stores or treat the entry as empty.

A missing or unusable signing identity fails the build and leaves the current
app installed. Restore access to the certificate and retry; Scope does not
silently change signers. To explicitly return to ad-hoc signing, run the
installer with `SCOPE_SIGNING_IDENTITY=-`. This may bring back repeated Keychain
prompts. Certificate-signed build copies follow the same cleanup policy as
other builds.

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

### Deletion and database maintenance

Closing a tab deletes its content. Quitting the app preserves tabs left open.
The CLI offers `delete ID`, `shrink`, and `hub shrink`. Use `--timeout-ms 120000`
for maintenance and `--status` on either shrink command to inspect its latest
receipt. Desktop shrinking through a hub still targets the Mac's two databases;
hub shrinking targets only the local hub. [Storage](storage.md) documents the
24-hour interval, 100 MB threshold, staging expiry, and schema upgrades.

Publication clients now persist a queued tab before sending content or metadata.
Update the desktop, CLI, and hub together. The ordinary CLI publication command
syntax is unchanged. Synthetic lifecycle tests include forced process termination;
maintenance tests use isolated databases and injected clocks, without operating
an installed profile.

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

### Diagram edit benchmark

After building, run the native Excalidraw comparison against an isolated real
desktop:

```sh
vp exec node tools/diagram-benchmark.ts /tmp/scope-diagram-benchmark.json
```

`SCOPE_DIAGRAM_BENCH_EDITS` selects 10–5000 edits per case (default 300). The
script compares identical native edit traces for 24, 240, and 1200 objects, plus
an image-heavy document. Both modes use optimistic versions; one sends field
deltas and the other sends the full native document. Each trace includes
competing updates and conflict retries. It verifies equivalent final content
and that deleting each tab removes its content blobs.

The JSON report separates initialization, median/p95 request latency, total
editing time, request bodies, HTTP headers, response bodies, and retained blob
bytes. Counts include failed stale requests, refreshes, and retries. They exclude
TCP/TLS framing, simulated human traffic, and deletion. API timing excludes
model inference and CLI process startup; response bytes are not model token
usage. Run it without concurrent builds or tests. Its temporary profile is
removed on completion.

### Concurrent diagram editing

After building, run `vp run test tests/diagram-pressure.test.ts --maxWorkers=1`.
Four fake agents compete over one named diagram through the HTTP API while
Playwright draws and types in the real editor. Three agents send deltas and one
sends full documents. Each operation increments a shared counter, updates its
agent's progress, and edits native objects. The test checks every acknowledged
increment and human drawing, text, additions, deletions, images, stale proposal
rejection, restart recovery, and deletion during incoming writes. Reusing the
name must reject a write carrying the deleted tab's version.

The default run uses 40 edits per agent and eight pairs of human drawings and
text entries. For a longer session:

```sh
SCOPE_DIAGRAM_PRESSURE_EDITS=250 SCOPE_DIAGRAM_PRESSURE_HUMAN=80 \
SCOPE_DIAGRAM_PRESSURE_SEED=7294 \
SCOPE_DIAGRAM_PRESSURE_OUTPUT=/tmp/scope-diagram-pressure.json \
vp run test tests/diagram-pressure.test.ts --maxWorkers=1
```

The optional report records elapsed time, accepted edits, version conflicts,
busy retries, full reads, renderer errors, and database content counts before
and after tab deletion. The seed controls the edit sequence and retry delays;
operating-system scheduling still varies. No live agent, account, or installed
profile is used. Temporary profiles and processes are removed on completion.
