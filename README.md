<img src="apps/desktop/resources/icon.png" alt="Scope, an open window with a blue breeze" width="96" height="96" />

# irudd-scope

A private workspace where coding agents leave things for a human to inspect. An Electron app stores and displays artifacts on the Mac. Local publishing works while Scope is open, without a VM. An optional paired hub persists remote CLI publications before delivery and attempts delivery while the Mac is connected. Codex and Claude can publish through the same CLI.

The repository is public. Artifact data and credentials stay private. Remote publishing belongs on a private tailnet. Paired Scope instances can exchange selected tabs over a separate encrypted connection.

SQLite stores artifact contents, metadata, ordinary settings, and workspace preferences. Mac provider and remote connection credentials live directly in Keychain. The private discovery file holds the CLI publishing token. The Mac owns delivered artifacts. Direct publishing requires Scope to be running; paired hubs buffer up to 50 pending publications for 48 hours.

## Install on macOS

```sh
curl -fsSL https://raw.githubusercontent.com/alundgren/irudd-scope/main/install.sh | bash
```

The installer keeps its own clone in `~/.local/share/irudd-scope`, installs
Vite+ if needed, and builds Scope locally. It installs a complete `Scope.app`
in `~/Applications` for Finder and Spotlight, then opens it. Re-running the
installer replaces an older managed app symlink automatically. Apple's command
line tools are required. If they are missing, run `xcode-select --install`,
finish that installation, and run the Scope installer again.

To reduce repeated Keychain prompts after updates, see [optional local signing](docs/development.md#optional-local-signing).

On startup, Scope checks the latest SHA on `main`. A new commit builds in the
background. Choose **Restart to update** when ready. Failed builds leave the
current app usable. Settings includes update status, build output, Cancel,
and Retry. There are no prebuilt downloads or GitHub release builds.

In **Settings → Agent tools**, install the `irudd-scope` CLI and the Scope
skill globally for Codex and Claude Code. The CLI uses the app's runtime and
updates with it. The skill button runs `npx skills add` using Vite+'s managed
Node/npm. Open a new terminal after installing the CLI.

See [installation and recovery](docs/development.md#installed-app) for paths,
build requirements, and removal.

## Send a tab to another Mac

In **Settings → Other Scopes**, create a pairing invitation. Send its link to
the other Mac and exchange the separately copied pairing secret through another
channel. On that Mac, choose **Enter pairing link** and enter both values.
Mac pairing credentials stay in Keychain. Either Mac can forget the pairing.

Choose **Send to another Scope…** under **Current tab** in search, select the
paired Mac, then copy the link or scan its QR code. On the target, open the link
or choose **Import from link…** in search. Review the authenticated tab details
before importing. Each invitation expires after fifteen minutes.

Both apps must be running and awake. Transfers create independent copies of
ordinary artifacts and editable diagrams. The source keeps its tab. Plans and
PR inboxes have additional records and cannot be transferred through this flow.
See [tab transfer](docs/architecture.md#tab-transfer) for connection and security
limits.

## Install on a remote

On a Linux remote already connected to your tailnet:

```sh
curl -fsSL https://raw.githubusercontent.com/alundgren/irudd-scope/main/install-cli.sh | bash
```

Open a new login shell and run `irudd-scope setup`. Review the installation
paths and private endpoint, then confirm. Setup installs the hub as a systemd
user service, installs the Scope skill for Codex and Claude Code, and configures
Tailscale Serve on an unused HTTPS port. Existing Serve routes stay intact.

Paste the printed pairing URL into **Scope → Settings → Remotes** on the Mac.
The link expires after ten minutes and can be used once. Scope keeps the
connection credential in Keychain and opens all connections to the remote.
The remote does not need permission to initiate connections to the Mac.

Run `irudd-scope pair` for a fresh link. Each hub pairs with one Mac. A Mac
can connect to several hubs independently. Disconnect and removal are in
Settings; service commands and prerequisites are in
[remote access](docs/development.md#remote-access).

After the installed Mac app updates and restarts, it updates connected remotes
to the same commit. Each remote builds its hub, CLI, and skill together before
restarting the hub. Offline remotes catch up when they reconnect. Settings →
Remotes shows progress and failed updates with Retry. Older installations need
one manual run of the standalone installer and `irudd-scope setup` to enable
this behavior.

## Development

Install the Vite+ version in the [workspace catalog](pnpm-workspace.yaml), then run:

```sh
vp install --frozen-lockfile
vp run ready
```

The project pins Node and pnpm through Vite+. Linux supports development and testing. macOS is the desktop deployment target.

Scope displays text, Markdown, raster images, interactive HTML, downloadable files,
and editable Excalidraw diagrams. Diagram generation uses an OpenRouter key
configured in the desktop. Built-in file and diagram plugins run inside a
shared tab host with persistent groups and events limited to each group.
Development launches run from the checkout and do not update themselves.

Pull request inboxes bind to one GitHub repository. Their first successful sync
normalizes a verified alias to its canonical path; later repository path changes
require a new inbox. See the [inbox commands](docs/development.md#github-pull-request-inboxes).

The [Scope CLI skill](.agents/skills/irudd-scope/SKILL.md) guides agents through
publishing artifacts, updating existing IDs, generating narration audio, and handling uncertain results.

See [development and launch commands](docs/development.md),
[architecture and ownership](docs/architecture.md),
[storage and recovery](docs/storage.md), [protocol](packages/protocol/README.md),
[technology](docs/technology.md), and [UI decisions](ux.md).
[Visual design](docs/visual-design.md) describes the desktop's shared tokens
and controls. Contributor instructions start in [AGENTS.md](AGENTS.md).

MIT licensed.
