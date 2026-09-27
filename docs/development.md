# Development

Use Vite+ `1.0.0-rc.1`. Node `26.10.0` and pnpm `12.6.0` are pinned. Dependencies use stable or release-candidate versions, with exact versions in the workspace catalog and lockfile. Do not adopt beta, alpha, nightly, or canary releases without a specific decision.

The stack is TypeScript, React, Vite+ with its bundled Vitest 5, Effect 4 RC, shadcn/ui, and Tailwind 4. Import test APIs from `vite-plus/test`. Add only UI components that the app uses. Electron main runs on Electron's bundled Node version, so its code must also work there.

```sh
vp install --frozen-lockfile
vp run ready
```

`ready` is the full standard validation command. It builds all entry points, runs standard tests, checks TypeScript, lints, and verifies formatting. CI uses the same command. Run it before every push and before reporting completion. Do not install pre-push hooks. Validation must not rewrite source or the lockfile.

Tests use temporary data directories and synthetic credentials. Prefer complete CLI-to-hub outcomes and desktop interactions, then integration tests for persistence, conflicts, resource limits, and HTML isolation. Live OpenRouter calls and native Mac Keychain access are separate manual checks. Passing Linux tests does not prove Mac signing or Keychain behavior.

The hub requires an application bearer token. Keep local credentials in ignored files or environment variables, and keep artifact data outside the checkout. The hub binds to loopback; use Tailscale Serve for Mac access. Do not expose the hub through a public listener or funnel.

## Run locally

After `vp install`, build with `vp run build`. The hub and CLI use Node. `vp run desktop` builds and opens Electron. Electron's bundled Node runtime is independent of the Node version used by Vite+.

Create a hub token outside the checkout. A Node command can write a random token without displaying it:

```sh
mkdir -p ~/.config/irudd-scope
vp exec node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; import { homedir } from "node:os"; writeFileSync(homedir() + "/.config/irudd-scope/hub.token", randomBytes(48).toString("base64url") + "\n", { mode: 0o600, flag: "wx" })'
```

Start the hub with `SCOPE_TOKEN`, `SCOPE_DATA_DIR`, and optional `SCOPE_PORT` in its environment, or use a private environment file with Node:

```sh
vp exec node --env-file=/path/to/private/hub.env apps/hub/dist/main.mjs
```

The environment file contains `SCOPE_TOKEN`, the token value, and optionally a data directory and port. It must stay outside Git. The defaults are port `43120` and `~/.local/share/irudd-scope`. The listener is always `127.0.0.1`.

Publish from the VM:

```sh
export SCOPE_TOKEN_FILE="$HOME/.config/irudd-scope/hub.token"
vp run scope text "The retry loop needs a bound." --title "Finding" --id finding
vp run scope add report.md --title "Review" --id review
vp run scope add screenshot.png --title "Layout"
vp run scope add preview.html --title "Preview"
vp run scope add build.zip --title "Build output"
vp run scope add architecture.excalidraw --title "Architecture" --id architecture
vp run scope update architecture architecture-v2.excalidraw
vp run scope list
```

The built executable is `packages/cli/dist/main.mjs`. Its shebang runs Node; put a wrapper or symlink named `irudd-scope` on your PATH once the configured Node runtime is available. `vp run scope` is the equivalent checkout command.

For a Mac client, expose the loopback hub with Tailscale Serve on an unused HTTPS port, preserving existing routes:

```sh
tailscale serve --bg --https=8450 http://127.0.0.1:43120
```

Set `SCOPE_ENDPOINT=https://your-vm.your-tailnet.ts.net:8450` for the Mac CLI and provide the same token through `SCOPE_TOKEN_FILE`. Copy that file privately through your existing SSH connection. The Mac CLI requires the same checkout and `vp install`; it does not need the Electron app open to publish files.

In Electron, open Settings and enter the hub URL and token. Select OpenRouter and Gemini 3.8 Flash, then enter the model API key. On macOS these credentials are encrypted through Keychain-backed secure storage. On Linux they stay only in memory; `SCOPE_ENDPOINT` and `SCOPE_TOKEN` can also configure a development launch. `SCOPE_DESKTOP_DATA_DIR` selects an isolated Electron data directory for tests or experiments.

Use Create diagram in the empty workspace or search. A generated diagram becomes a normal artifact in the hub. Use the change field on its canvas for targeted edits, then Save. Model output is validated before application. A failed request does not change the canvas.

## Checks and current limits

Linux desktop tests require Xvfb and the Electron shared libraries. On Ubuntu, install `xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64`. The test command starts an isolated Xvfb display when necessary. Standard tests use real Electron, a real temporary SQLite hub, the built CLI, and synthetic provider responses.

`vp run ready` builds, runs Vite+'s format/lint/type checks, then runs the integration and Electron tests. Use `vp run test tests/desktop.test.ts` or `vp test run tests/artifacts.test.ts` for focused checks after building. `vp check --fix` explicitly applies formatting or lint corrections; the standard command never does so.

Artifacts are durable. Unsaved canvas edits are local to the current desktop process and need Save before quitting. HTML previews permit inline styles and embedded data images; scripts, external assets, forms, nested frames, and navigation are blocked. Markdown does not execute raw HTML or load remote images.

The desktop currently runs from a checkout. A signed Mac application bundle and its native Keychain acceptance check are still required before distributing releases. Linux tests do not establish that behavior. Local Codex/Claude providers, remote generation requests, session tools, and tool-size hooks are planned capabilities, not working settings.

SQLite and blob storage need a backup policy before storing irreplaceable work. Stop the hub before copying its data directory, or use SQLite's online backup API and copy the referenced blobs. Do not copy only `scope.db` while a running hub may have committed data in its WAL file.
