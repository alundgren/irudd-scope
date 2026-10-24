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

## Installed Tailcat transport

Tab transfer requires Tailcat installed separately by the user on each desktop.
Windows uses native `tailcat.exe` on PATH. Scope discovers the CLI through PATH, then `/opt/homebrew/bin/tailcat` and
`/usr/local/bin/tailcat` for GUI-launched Mac apps. Scope provides no installer
or installation action. The adapter uses the Tailcat v0.7.0 CLI interface;
installed versions must support the same JSON listener and port-forwarding commands.

The desktop build compiles a TypeScript transport supervisor with Vite+.
Scope uses its existing Electron runtime to supervise the user-installed CLI.
Builds and packaging need neither Tailcat nor a Go compiler and redistribute
no Tailcat binary or Go dependencies. Standard tests use synthetic local CLI
subprocesses and need no Tailcat installation or live relay.

The optional `vp exec node tools/check-transfer-transport.ts` smoke test uses
an already installed Tailcat CLI and sends synthetic content through its hosted
relay. It runs separately from `ready`, never installs dependencies, and uses
no personal artifacts or provider credentials.

Sharing-link creation and Scope-to-Scope pairing stay in the desktop app. A receiver
can authorize an agent to run `irudd-scope import-link 'scope-transfer://v2/#...'`
through its normal Scope connection. Main imports without a desktop receive
click, retaining the same pairing, expiry, validation and retry guarantees.
Both computers must be awake and online; a connected paired hub can forward the
request, but imports are never queued. The command defaults to a bounded
300,000 ms timeout. Retry the same link if its result is uncertain.

## Validation and tests

`vp run ready` builds the CLI, hub, and desktop, runs `vp run check`, then runs
the standard test suite. The check script verifies formatting, lint, types, and the test rules below,
with compact lint diagnostics. Run it locally; CI has no test or validation jobs.

During development, run `vp run check` and the test files that cover the code
you change, for example `vp run test tests/folder-local.test.ts`. Run
`vp run ready` once when you consider the change complete. Run the full suite
again only after it fails. Edits made after a passing full run need only
`vp run check` and the tests that cover them. Documentation-only changes need
`vp run check`.
Validation does not rewrite source or the lockfile. Do not install validation hooks.

`vp run test` selects the `standard` Vitest project, which excludes the
dedicated remote-update suite. That suite also stays out of `ready`.
Shared desktop, workspace, and publication journeys
remain in the standard suite.

Run `vp run test:remote-updates` only after direct changes to remote update
logic, such as desktop update synchronization, hub update execution, rollback,
or update-driven skill synchronization. It uses the same display setup and test
settings as the standard suite. Build first with `vp run build`.
Documentation, test-selection changes, and unrelated shared infrastructure
changes alone do not require it.

```sh
vp run test:remote-updates
```

Standard validation runs at most two test files concurrently to keep Electron
interaction responsive. macOS runs one file at a time because native fullscreen
windows share the same display and compete for focus.
Use `vp run test --maxWorkers=N` to override the file-worker count.

Keep successful tests quiet. The minimal reporter prints totals without listing
passing tests and shows console logs only for failures. The display runner also
holds Xvfb diagnostics unless the run fails. On failure, it counts repeated
nonfatal XF86 keysym warnings and repeated libEGL permission warnings. It keeps
the first libEGL warning and all other Xvfb diagnostics. For detailed investigation, use
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
run `vp run check` again. Naming, ownership, and documentation accuracy remain
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

Tests import from `vite-plus/test`. `vp run check` enforces three test rules
through `tools/test-rules.ts`:

- Every test names a promise. [tests/promises.ts](../tests/promises.ts) lists
  what Scope promises the people who use it. Each test lists the promises it
  protects in its own options, for example
  `test("name", { tags: ["survives-restart"] }, async () => {})`. Vitest
  rejects unknown names. Suites and `@module-tag` comments cannot apply
  promises. If no promise fits, the test is not needed. The repository owner
  decides the list; agents propose changes in the pull request description.
- Tests use Scope's entry points. Files in `tests/` reach Scope only through
  the built CLI, the artifact and hub HTTP APIs, the Electron UI, and
  `@irudd-scope/protocol`. They cannot import from `apps/`, `packages/`, or
  other workspace packages, so a test cannot copy code it cannot see.
  [tests/test-limits.ts](../tests/test-limits.ts) lists files written before
  this rule with their remaining product imports and test counts. They take
  no new imports or tests. Lower an entry when you remove an import or test.
- The suite has a fixed size. `maxTests` in `tests/test-limits.ts` caps the
  number of test definitions, including skipped ones. Add a test by deleting a
  weaker one. Only the repository owner raises the limit. The cap counts tests
  instead of time because suite time differs between machines.

When a test fails after a change that keeps behavior the same, delete it
instead of updating it. It was checking how the code works, not what Scope
promises. Update a test only when promised behavior changed on purpose.

`vp run test:report --since=YYYY-MM-DD` lists merged pull requests since the
date, 30 days ago by default, with the tests each one added, deleted, and
edited. It marks changes to `tests/promises.ts` and `tests/test-limits.ts`,
counts merged `fix` pull requests as bugs that reached `main`, and prints how
many tests protect each promise. Reformatting, timeouts, and promise tags do
not count as edits. It needs `gh` and a fetched `main`. A high edit count means
tests are checking how code works instead of what it promises.

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
Add a test when it protects a promise that no existing test covers well.
Do not duplicate every assertion in several tests. Coverage percentages are
not goals.

Keep tests and small synthetic fixtures in `tests/`, where publication tests
can exercise multiple owners. Name tests for the responsibility they verify.
Use temporary data directories, isolated discovery files, ephemeral ports,
and synthetic provider responses. Standard tests need no credentials, live
models, or production data. Cleanup must close processes and databases and
remove temporary data. Do not add application tests for prose-only edits;
inspect changed text, links, and formatting instead.

Choose additional evidence for the change's claims, such as the performance
protocol below for performance work. State what the evidence establishes and
its limits in the PR. Passing standard checks does not replace the requested
behavior.

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
Windows installation, DPAPI access, or live OpenRouter behavior. Validate those separately on their real platform
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
disable background throttling so UI timers continue running. Native fullscreen
and HTML presentation tests request visible Mac windows for native transitions
and pointer interaction. Run GUI tests in an isolated graphical session; a hidden
window or a separate macOS Space does not isolate the desktop. Linux test windows
remain visible because Chromium stalls CSS animations in hidden windows, which
prevents dialogs from closing and restoring focus. Each automated Linux Electron
session uses its own Xvfb display so parallel windows cannot steal pointer capture
or interrupt drag gestures. Tests run the real main process, renderer, IPC, and database
operations. Unexpected native dialogs fail tests with diagnostics instead of
waiting for someone to dismiss them. Use
`SCOPE_TEST_SHOW_WINDOWS=1 vp run test tests/workspace.test.ts` to show windows
on the current display and allow native dialogs during manual checks. Installed apps are unaffected.

### Performance measurements

The comprehensive Linux protocol keeps one visible Electron session running while
it measures individual features, mixed usage, equivalent repeat workloads,
cleanup and restart. Build first, then select a new absolute run directory:

```sh
vp exec node tools/performance.ts --smoke --run-dir /absolute/path/smoke
vp exec node tools/performance.ts --duration 8h --run-dir /absolute/path/overnight --okf-binary /absolute/path/irudd-okf
```

`--smoke` defaults to four minutes. `--duration` accepts seconds, minutes or
hours, for example `30s`, `4m`, or `8h`. Fixture setup precedes the measurement
deadline. Smoke reserves at least 75 seconds for the final comparison and
restart scenarios. `--inject-failure` adds an intentional smoke failure to check that
later scenarios still run. `--okf-binary` opts into native local Librarian
measurements with synthetic notes and isolated configuration. Without a compatible binary,
Librarian uses the existing synthetic OKF fixture and records native timing as
unmeasured. Memory sync always uses
synthetic external services.

The controller owns a monotonic deadline, worker heartbeat watchdog, process
group cancellation and bounded recovery. It stops for disk or memory pressure
and bounds content, logs and open tabs. Run it alone, without concurrent builds
or tests. SIGINT and SIGTERM preserve partial reports and stop the worker's
children. Final cleanup removes routine isolated state and retains reports.
The selected run directory must not already exist. Every run must start its
measurement clock, complete the requested duration and record all required
features, phases and checkpoints to report success. Interrupted and incomplete
runs preserve their reasons. Cleanup verifies that owned process groups stopped
before removing profiles; failed termination retains those profiles.

`events.jsonl` records operations and coverage, `resources.jsonl` records
centralized Electron process CPU/RSS, database sizes and renderer frame/timer
samples, and `external.jsonl` records command intervals with workload identity.
`summary.json` is refreshed during the run and `run-state.json` records its
status. Logs and reports stay below the selected directory. Percentiles use
nearest rank and include actual sample counts. CLI, API, visible interaction
and integration measurements remain separate. The known-delay smoke scenario
checks that an injected GitHub command delay appears in external timing data.

Read coverage reasons before interpreting a report. Linux uses software
rendering on isolated Xvfb displays. Synthetic providers, GitHub and transport
establish integration behavior; they do not measure live services. Native
platform dialogs, macOS/Windows behavior and Tailcat relay latency remain
unmeasured. External durations can overlap application work. Remaining elapsed
time is unattributed, and rising RSS alone does not establish a memory leak.

## Personal memory viewer

The Personal memory tab calls an installed irudd-okf through the existing
memory sync process runner. No browser server needs to be started. Workspace
search and Memory Settings provide the opening action. The tab needs an enabled,
connected and locally registered memory clone for wiki, search, graph and edits.

Windows requires a compatible native `irudd-okf.exe` on PATH. Its upstream
project does not provide a Windows installer. Scope shows that prerequisite
instead of its Bash installer, skips automatic irudd-okf upgrades on Windows,
and preserves sync and file operations when a compatible executable is present.
Native `git.exe` and `gh.exe` must also be on PATH, with `gh` authenticated as
the current desktop user. macOS and Linux retain the daily tool upgrade.

`tests/memory-viewer.test.ts` exercises the native tab in real Electron with
synthetic memory files and CLI responses, without credentials or a live
GitHub repository. The synthetic CLI models file hashes and save conflicts.

## GitHub pull request inboxes

Ask the agent in an existing coding session to author and publish a named HTML
inbox. The Scope skill links to [PR inbox authoring](../.agents/skills/irudd-scope/references/pull-requests.md)
for the creation workflow, data model, SDK methods, and agent commands.
Create PR inbox in the desktop also creates an inbox for `OWNER/REPO`.

```sh
irudd-scope add inbox.html --pull-requests --name repository-inbox
irudd-scope pull-requests configure repository-inbox OWNER/REPO
irudd-scope pull-requests read repository-inbox
irudd-scope pull-requests sync repository-inbox
irudd-scope pull-requests guide
```

The awake desktop runs its installed `gh` using the current user's GitHub login.
Install and sign in to GitHub CLI on that computer before syncing. Scope checks the
process PATH, including native `gh.exe` on Windows, and the usual Mac Homebrew install locations. V1 supports repositories
on `github.com`. No new GitHub credentials are stored by Scope.

The first successful sync resolves GitHub repository aliases and stores the
verified canonical path. For example, `facebook/react` becomes `react/react`.
Read the snapshot to see the binding. A successful inventory pins that path,
including an empty inventory. Later renames or transfers require a new inbox;
a failed refresh keeps the existing binding and cached data.

Selecting the tab or clicking Sync refreshes every open PR, including drafts.
There is no polling or closed PR archive. A failed sync keeps the cached list
and adds a small error indicator to Sync; its tooltip explains the failure and
clicking retries. Notes, snoozes, and local review marks never submit GitHub
comments or reviews. Use Open on GitHub for those actions.

Published HTML runs as trusted agent output. Agents can update the same named
tab with `irudd-scope update repository-inbox inbox.html`; the repository and
current review state stay attached to the tab. The injected HTML SDK and
validated agent commands are documented in the
[protocol README](../packages/protocol/README.md). Paired hubs forward these
commands only while the desktop is connected.

Standard PR tests use a fake `gh` and isolated databases. They require no
GitHub credentials and perform no live GitHub mutations.

## Agent retrospectives

Start a normal coding session and ask for a Scope retro. The packaged Scope
skill provides the [collection and review workflow](../.agents/skills/irudd-scope/references/retros.md).
The public [irudd-scope-retro skill](../.agents/skills/irudd-scope-retro/SKILL.md)
provides metadata discovery and explicit historical-session snapshots. Both
Scope skills install together for Codex and Claude Code. Resolve the bundled
Python 3 helper relative to the loaded retro skill on each source host,
including SSH hosts.
Scope does not install a source service or use paired hub endpoints as SSH
aliases.

```sh
irudd-scope retro guide
irudd-scope retro settings
irudd-scope add report.html --retro --name retro-checks
irudd-scope retro read retro-checks
irudd-scope retro apply command.json
irudd-scope retro history
```

Configure source/runtime roots and canonical origin inclusion choices in Scope
settings or through validated retro configuration commands. For first-use
history the agent asks Start now, Check first, or All. Interactive commands need
the desktop connected. Retro HTML runs freely with a scoped review SDK and
contains no Finish button. The operator tells the agent to finish after agreed
changes and their outcomes are recorded.

Native source histories can be absent, cleaned up, encrypted or incomplete.
Represent missing evidence honestly. Unavailable sources need an explicit
coverage override to continue; their tracking remains unchanged. Standard
checks use synthetic native records, repositories and source commands without
credentials, live agents or personal sessions.

## Run locally

`vp run desktop` builds and opens Electron. Main starts the local publishing
API and opens SQLite. No hub process or connection form is needed. The computer
must stay awake with Scope open to accept publication.

With Scope open, publish synthetic content from another terminal:

```sh
vp run scope text "The retry loop needs a bound." --title "Finding" --id finding
vp run scope add report.md --title "Review" --id review
vp run scope add screenshot.png --title "Layout"
vp run scope add preview.html --title "Preview"
vp run scope add build.zip --title "Build output"
vp run scope update review report-v2.md
vp run scope list
vp run scope get review
```

`get` returns metadata. Use Download in the desktop to save content. Install
the CLI from the installed app's Settings to use `irudd-scope` on PATH.
The checkout's built CLI is `packages/cli/dist/main.mjs`; its Node shebang
requires the configured Node runtime. For repeated agent calls, use that executable
or `./packages/cli/dist/main.mjs` directly. `vp run scope` invokes the source in
the checkout. Pass `--help` to the chosen command for options. The
[CLI skill](../.agents/skills/irudd-scope/SKILL.md) describes publication and recovery.

Publication returns a JSON record after storage commits. Rendering in the
desktop runs independently of that receipt. Publication commands
publish finished files. Optional Git provenance has a
short time limit and stays absent if it cannot be collected.

Publication commands share a 10-second deadline, including uploads and response bodies.
Use `--timeout-ms 60000` for a slow remote transfer. If a command times out after
publication starts, check its artifact ID with `get` before retrying, since the
write may have committed without a receipt.

Scope writes its local endpoint and publishing token to a private discovery
file. The CLI reads it automatically. See [storage](storage.md) for file
locations, backup, and import behavior. Quitting Scope leaves the discovery
file in place but stops publication.

Open Settings from the search panel or Command-comma. The search button and
Command-K open workspace controls, current-tab actions, and artifact search.
Search also finds settings such as appearance and voice generation. Appearance
follows System unless Light or Dark is selected. Voice generation uses the
shared key saved in Settings → OpenRouter. On macOS keys live in Keychain. Windows stores them with DPAPI
encryption for the current account in `desktop.db`; Linux development keeps them in memory.
Scope reads the key for generation, billing lookup, key changes, or when the
OpenRouter section opens. Startup and other settings changes do not read it.
Turning voice generation off retains the key. Enabled remotes still access
their saved credentials when connecting at startup.

Search the panel for Sketchpad to open the personal Excalidraw canvas. Its
drawing saves automatically and only the person uses it; agents have no
commands for it. HTML previews run trusted agent output with
scripts, external styles, images, fonts, network requests, forms, and popups.
Publish a complete HTML document. Resources must be embedded or use reachable
URLs; publishing a file does not upload adjacent files. A document can set its
own base URL. Normal browser rules such as CORS still apply. Markdown
omits raw HTML and renders link labels and image descriptions as text.

## Installed app

Scope builds from source on macOS and native Windows 11 x64. The installers
provision the pinned Vite+, Node, and package manager. Neither platform needs
a separate Node installation. Windows ARM and WSL desktop installations are
not supported. Closing the last window saves pending changes and quits on
both platforms; there is no background desktop service.

### Windows installation

Install Git for Windows and run the root [PowerShell installer](../install.ps1):

```powershell
irm https://raw.githubusercontent.com/alundgren/irudd-scope/main/install.ps1 | iex
```

A downloaded script can be run as `.\install.ps1`. Run it as the normal user
in native PowerShell. The installer uses the Windows PowerShell .NET Framework
compiler to build its launchers. It needs no administrator access, Developer
Mode, or Visual Studio. Vite+ is bootstrapped from `https://vite.plus/ps1` at the
version pinned in Scope's workspace catalog.

| Location                                           | Purpose                                               |
| -------------------------------------------------- | ----------------------------------------------------- |
| `%LOCALAPPDATA%\irudd-scope\source`                | Managed Git clone and build dependencies.             |
| `%LOCALAPPDATA%\irudd-scope\builds\<commit>\Scope` | Complete immutable app build.                         |
| `%LOCALAPPDATA%\irudd-scope\current`               | Junction selecting the active build.                  |
| `%LOCALAPPDATA%\irudd-scope\previous`              | Junction retaining the previous build.                |
| `%LOCALAPPDATA%\irudd-scope\prepared`              | Junction selecting a prepared update.                 |
| `%LOCALAPPDATA%\irudd-scope\Scope.exe`             | Stable desktop launcher.                              |
| `%LOCALAPPDATA%\irudd-scope\bin\irudd-scope.exe`   | Optional native CLI launcher installed from Settings. |

`SCOPE_INSTALL_ROOT` can select another absolute local installation directory.
The installer creates the per-user Start Menu shortcut and `scope-transfer`
protocol registration against the stable launcher. App updates prepare a
separate build, then **Restart to update** flushes pending saves and selects
that build. Activation keeps the running executable in its original directory
and restores the previous selection if it fails. Desktop launching, the CLI,
and bundled skills follow the same active build. A failed build leaves the
current app usable. Settings shows progress, cancellation, and retry.

Settings → Agent tools installs the native CLI launcher and adds its `bin`
directory to the user PATH. Open a new terminal before using it. Remove CLI
removes that PATH entry. Skill installation uses directory junctions under
`%USERPROFILE%\.agents\skills` and `%USERPROFILE%\.claude\skills`, and repairs
managed links under `.codex\skills` when present. It needs no symlink privilege
or network request. Existing unrelated files remain untouched. Refresh or
start an agent session after updating skills.

Use Settings to remove the CLI and skills before removing the app. Quit Scope,
delete its Start Menu shortcut and installation directory, and remove the
`HKCU\Software\Classes\scope-transfer` registration if it still points to that
installation. The independent desktop profile in `%APPDATA%\irudd-scope`
remains. The discovery file and memory clone live under the default installation
root, so preserve them before deleting that directory if needed. See
[storage](storage.md) for credentials, data locations, and backup limits.

### macOS installation

The root [shell installer](../install.sh) runs on macOS with Apple's command line
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

The Mac app bundles `irudd-scope` and `irudd-scope-retro` from the same commit
as its CLI. Install skill creates global links for Codex and Claude Code;
those links follow the active app build, including updates and rollback.
Installation and Repair skill need no network access. Refresh or start a new
agent session after an update to reload discovered skill guidance.

Startup repairs incomplete managed links and migrates older copies registered
by the skills CLI as coming from this repository. It preserves those copies,
including local edits, under `skill-backups/` in the installation directory
and removes only their entries from the skills CLI registry. Separate copies
or links to another installation remain untouched; Settings reports the
conflicting path. Removing the skills keeps them uninstalled across updates.
The CLI also follows the active app build through its installed link; it needs
no separate update command.

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
| `SCOPE_SESSION_CREDENTIALS=1` | Keep credentials in memory on macOS or Windows. Standard Electron tests set this.                 |

## Remote access

Install the standalone CLI on the remote with the root `install-cli.sh`. It
builds only the CLI and hub packages, copies the managed Node runtime into
the installation, and links `~/.local/bin/irudd-scope`. It does not install
the desktop. Linux and macOS can install the CLI; managed hub setup currently
requires Linux, `flock` from util-linux, a working systemd user service manager,
and user lingering.
Successful installations and remote updates remove unused directories directly
under the CLI installation's `builds` directory. They retain builds selected by
`current`, `previous`, or `prepared`, and builds used by running CLI or hub
processes. Preparing a build or failing an installation does not prune older
builds. If installation links or the full process list cannot be read safely,
cleanup is skipped. Source checkouts, links, and user data stay in place.
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
`irudd-scope skill check` validates the installed links and skill bytes without
changing them. `irudd-scope skill sync` repairs links belonging to this standalone
installation and verifies the result. Both print an `installed` JSON boolean;
an invalid or separate installation exits nonzero with its path and recovery
instructions. A pre-existing Codex-specific skill path is checked as well.

Paste the pairing URL into Settings → Remotes in Scope. The secret is in the
URL fragment. Links expire after ten minutes; generating another invalidates
the previous link. A successful pairing exchanges it for a connection token
stored in the desktop's protected credential store. The hub stores credential hashes in SQLite. Each hub
pairs with one desktop. Use `irudd-scope hub unpair` before pairing another desktop.

The desktop opens all relay connections through the remote's Tailscale Serve
endpoint. The hub only binds to loopback. A tailnet rule permitting desktop-to-remote
HTTPS is sufficient; remote-to-desktop initiation is unnecessary. CLI publication
uses its private local discovery file without endpoint flags. The hub streams
active requests. CLI `add`, `text`, and eligible `update` publications always
persist in hub SQLite before delivery, up to 50 tabs for 48 hours from
reservation. Connection state only controls delivery attempts. Complete entries
deliver in the background while Scope is connected, including after reconnect.
Transient failures wait 3 seconds before retrying, doubling to a 5-minute cap.
New publications and ordinary reconnects respect that cooldown. On the system
resume event, Scope reconnects enabled remotes with a one-time wake signal that
resumes delivery immediately. Manually disconnected remotes stay off. This adds
no periodic desktop ping task.
A queued JSON receipt reports `id`, `queued: true`, and `expiresAt`; it does
not mean the desktop has received or rendered the artifact. Inspect with
`irudd-scope hub queue` and cancel with `irudd-scope hub discard ID`.
Conflicts remain visible in the queue until discarded or expired. `update ID_OR_NAME FILE`
uses the current desktop revision while connected. Offline it uses metadata
previously read or published through this hub, preserving the saved name and title.
The hub retains up to 1,000 recent artifact records for 48 hours after observation.
If the saved revision is missing, read the artifact through the hub while connected first.
If the desktop revision changed, delivery blocks without replacing newer content.
Speech generation and maintenance are never buffered. Synchronous clients that omit the buffering header retain live
forwarding. A live request interrupted by disconnection can fail;
check the artifact and queue before retrying an uncertain publication.

Enabled remotes reconnect automatically while Scope runs. Disconnect remains
off until Connect is selected. Remove remote revokes the hub credential;
if the hub is unreachable, reconnect it and retry removal. `irudd-scope hub
stop` and `start` control the user service. `hub remove` revokes access and
removes only its service and Serve route, preserving the CLI, skill, and
settings. It requires the hub to be running. Logs are available through
`journalctl --user -u irudd-scope-hub.service`.

The installed desktop app requests remote updates after it is running the new
version. Enabled remotes update on connection, including after being offline.
The requested commit is the running desktop's commit, never a prepared update or
whatever happens to be latest on `main`. The remote verifies that commit is on
the repository's `main` history and refuses a downgrade or a different history.
Development launches do not request updates.

The hub starts `irudd-scope-update.service` as a separate transient systemd
user service. It fetches and builds while the existing hub keeps serving, then
switches the CLI, skill, and hub together and restarts the hub. Publication is
briefly unavailable during restart; active transfers can fail and are not
replayed. The worker checks the replacement's running commit and restores the
previous build if startup fails. It then checks the agent's installed skill and
repairs links pointing to an older build of the same standalone installation.
Separate skill copies or links to another installation remain untouched and
produce an update error with the affected path. The updated CLI and hub stay
available while that skill error is resolved. Moving the separate copy aside,
running `irudd-scope skill install` on the remote, and selecting Retry update
rechecks the skill without rebuilding tools already at the requested commit.
Removing all skill links explicitly keeps the skill uninstalled across updates.
Refresh or start a new agent session after updating the skill so its discovery
description and loaded guidance reflect the new files.
Pairing, discovery, and Serve configuration
stay in place. An accepted update can finish after the desktop disconnects.

Settings → Remotes shows progress and Retry update on failure. Failed attempts
are retained in `hub.db` and do not repeat automatically for the same commit.
Worker logs are in `journalctl --user -u irudd-scope-update.service`. Linux
installation locks release when the updater exits, including after a crash.

Older hubs cannot receive update requests. Re-run the standalone installer and
`irudd-scope setup` once on each such remote. This remains the manual recovery
procedure for an unavailable hub. The installer updates its payload; setup
restarts the hub. Completed builds live in
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

Closing a tab moves it to Trashcan. Quitting preserves active and trashed tabs.
The CLI offers `delete ID`, `shrink`, and `hub shrink`. Use `--timeout-ms 120000`
for maintenance and `--status` on either shrink command to inspect its latest
receipt. Desktop shrinking through a hub still targets the desktop's two databases;
hub shrinking targets only the local hub. [Storage](storage.md) documents the
24-hour interval, 100 MB threshold, staging expiry, and schema upgrades.

Publication clients now persist a queued tab before sending content or metadata.
Update the desktop, CLI, and hub together. The ordinary CLI publication command
syntax is unchanged. Synthetic lifecycle tests include forced process termination;
maintenance tests use isolated databases and injected clocks, without operating
an installed profile.

### Direct HTTPS access

Direct desktop access and the original forwarding mode remain available when
your tailnet permits callers to initiate connections to the desktop.

Expose the desktop's loopback API through Tailscale Serve on an unused private
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
pointing to the desktop's HTTPS endpoint and `SCOPE_TOKEN` containing the same
publishing token. `SCOPE_PORT` selects its loopback port, default `43120`.
After building:

```sh
vp exec node --env-file=/path/to/private/hub.env apps/hub/dist/main.mjs
```

Use Tailscale Serve for private access to that listener when needed. The hub
has no database, content directory, queue, or replay. It returns 503 when it
cannot reach the desktop before sending response headers; interrupted streams
close. Both paths require an awake desktop running Scope. Do not expose either
listener through a public listener or funnel. Provider keys belong only to
desktop main.

### Relay diagnostics

Forwarding failures are written to desktop stderr as `Scope relay` JSON records.
They include the relay request ID, method, path, active phase, elapsed times,
received body bytes, body completion, cancellation state, and error causes.
Set `SCOPE_RELAY_TRACE=1` when launching a diagnostic desktop to also record
successful phase transitions. Capture that process's stderr explicitly; a
Finder-launched app may have stdout and stderr connected to `/dev/null`.
Diagnostics omit credentials, headers, and artifact contents.

Body retrieval streams into local HTTP, so their durations overlap. `body-headers`
only means the hub sent response headers; `body-ended` means the full input
stream arrived. `local-response` includes body transfer and local API/storage
work, while `response-delivered` includes the hub's acknowledgement. A
`forward-error` in `local-http` with `bodyComplete: false` can therefore be an
input-stream failure, not a storage failure. Correlate `body-error` and
`canceled` records by request ID before attributing the delay. A missing final
record alone does not establish whether a write committed. Read the artifact
before retrying an uncertain publication.

## Speech generation

Enable Voice generation in desktop Settings and save the shared key in the
OpenRouter section. Voice generation is off by default. Turning it off preserves
the key. The desktop
uses `google/gemini-3.8-flash-tts` through OpenRouter's speech endpoint. New requests default to Aoede with restrained
conversational delivery; two-speaker scripts use Aoede to lead and Leda to reply.
Agents generate turns separately and assemble the exported WAVs.
The agent workflow and recovery rules are in the
[protocol guide](../packages/protocol/README.md#agent-speech-generation) and
`irudd-scope voice guide`; `irudd-scope voice --help` lists the commands.

Standard speech tests use a fake external provider through real HTTP, the built
CLI, paired-hub relay, and desktop settings. They require no live key or model.

## Prompt curation commands

```sh
irudd-scope prompts guide
irudd-scope prompts structures
irudd-scope prompts read
irudd-scope prompts list
irudd-scope prompts item UUID
irudd-scope prompts apply request.json
irudd-scope prompts image image-request.json example.webp
irudd-scope prompts export --output library.zip
```

The guide prints a machine-readable schema. Item and workspace writes need an
expected revision and stable UUID request ID. Image request files use
`action: "set-image"`, `id`, `requestId`, and `expectedRevision`, omitting `image`;
the CLI reads the explicit file and inserts its MIME type and base64 bytes.
Use an ordinary `set-image` command with `image: null` to remove it.
PNG, JPEG and WebP examples are limited to 8 MiB and 4096 pixels per dimension.
Exports refuse existing files and contain only the library, with no current
workspace text. All prompt operations require the desktop connected, including
through paired hubs. They never navigate the desktop or queue offline.

The prompt storage, API, built CLI and paired relay tests use synthetic images,
isolated databases and no provider credentials. See the
[protocol](../packages/protocol/README.md#prompt-library-and-current-workspace)
for limits, pagination and retry handling.

`prompts-desktop.test.ts` runs the current editor and picker in real isolated
Electron with the built CLI. It covers library images, copied text, explicit
Restore, reset and undo, native ZIP export, hide/restart, divider keyboard
persistence, concurrent deletion, failed quit recovery, uncertain save retries
with later typing, and missed-event refresh. The visual journey checks long
synthetic text at 1366×768, 1440×900 and 1920×1080 in both appearances.
`SCOPE_TEST_SCREENSHOTS` optionally saves screenshots and layout measurements
outside the repository. Existing desktop fixture users explicitly hide the
startup Prompts tab when their scenario needs an initially empty strip; the
real built-in tab remains retained and its storage is included in assertions.

## Try structured plans from a local checkout

Build and run matching desktop and CLI code. On macOS, from the checkout root:

```sh
vp install --frozen-lockfile
vp run build
export SCOPE_PLAN_TRIAL_DIR="$(mktemp -d -t scope-plan-trial)"
export SCOPE_DESKTOP_DATA_DIR="$SCOPE_PLAN_TRIAL_DIR/desktop"
export SCOPE_DATA_DIR="$SCOPE_PLAN_TRIAL_DIR/artifacts"
export SCOPE_CONNECTION_FILE="$SCOPE_PLAN_TRIAL_DIR/connection.json"
export SCOPE_SESSION_CREDENTIALS=1
export SCOPE_PORT=0
vp run desktop
```

In a second terminal at the same checkout, set `SCOPE_CONNECTION_FILE` to the
same temporary connection path. Keep `SCOPE_ENDPOINT`, `SCOPE_TOKEN` and
`SCOPE_TOKEN_FILE` unset so local discovery selects this instance. Do not print
the connection file. Publish either [synthetic plan example](../.agents/skills/irudd-scope/examples/plans/README.md)
through the freshly built CLI. This leaves the installed app profile and hub alone.
Quit the trial instance before deleting its temporary directory.

The native Overview and Work items views require this version's desktop. Installed
older hubs reject JSON plans until their CLI/hub protocol is updated separately.
Use direct local discovery for the first trial. Same-version hub queues keep the
normal receipt and revision-conflict behavior. A queued write is not a delivered
plan. Reads and basis capture require the desktop connected.

### Native guest connection transport check

After building the desktop, `vp exec node tools/check-guest-transport.ts` runs an
optional CLI-only check with the installed Tailcat, synthetic in-memory private
keys, and a temporary authenticated HTTP listener. It generates and restores the
key through the platform's protected pipe, restarts the transport worker, checks
the same address, and sends authenticated and rejected requests through the
PSK-preserving SOCKS path. It prints only outcomes and stops its child processes.
This uses live relays and is outside the standard suite. Run it separately on
macOS and Windows; a Linux result does not establish native pipe or credential
behavior. Windows requires built-in Windows PowerShell and its .NET Framework
named-pipe security APIs. Protected pipe failures stop guest setup without a
plaintext fallback. Standard connection tests use a synthetic local CLI.
