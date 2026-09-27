# Development

Use Vite+ `1.0.0-rc.1`. Node `26.10.0` and pnpm `12.6.0` are pinned. Dependencies use stable or release-candidate versions, with exact versions in the workspace catalog and lockfile. Do not adopt beta, alpha, nightly, or canary releases without a specific decision.

The stack is TypeScript, React, Vite+ with its bundled Vitest 5, Effect 4 RC, shadcn/ui, and Tailwind 4. Import test APIs from `vite-plus/test`. Add only UI components that the app uses. Electron main runs on Electron's bundled Node version, so its code must also work there.

```sh
vp install --frozen-lockfile
vp run ready
```

`ready` is the full standard validation command. It builds all entry points, runs standard tests, checks TypeScript, lints, and verifies formatting. CI uses the same command. Run it before every push and before reporting completion. Do not install pre-push hooks. Validation must not rewrite source or the lockfile.

Tests use temporary data directories and synthetic credentials. Prefer complete CLI-to-hub outcomes and desktop interactions, then integration tests for persistence, conflicts, resource limits, and HTML isolation. Live OpenRouter calls and native Mac Keychain access are separate manual checks. Passing Linux tests does not prove Mac signing or Keychain behavior.

## Run locally

After `vp install`, run `vp run desktop` to build and open Electron. Electron main starts the local publishing API and owns the SQLite database. No separate hub process or connection settings are needed. Electron's bundled Node runtime is independent of the Node version used by Vite+.

On macOS the default artifact directory is `~/Library/Application Support/irudd-scope/artifacts`. It contains `scope.db` and the `blobs` directory. Provider settings remain in Electron's user data directory.

Scope creates `~/.config/irudd-scope/desktop.json` with mode `0600`. It contains a versioned local endpoint and bearer token. The CLI discovers these automatically. Keep this file private and outside Git. Quitting Scope leaves the connection file in place, but publication fails until the app is running again.

With Scope open, publish from another terminal on the Mac:

```sh
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

Settings contains the diagram provider, model, and API key. OpenRouter and Gemini 3.8 Flash are the initial choices. On macOS the provider key is encrypted through Keychain-backed secure storage. Linux development keeps it in memory. Existing version 1 settings retain the provider key and discard the obsolete hub fields when next saved.

Use Create diagram in the empty workspace or search. A generated diagram becomes a normal artifact stored on the Mac. Use the change field on its canvas for targeted edits, then Save. Model output is validated before application. A failed request does not change the canvas.

For isolated development or tests, set `SCOPE_DESKTOP_DATA_DIR` for Electron preferences, `SCOPE_DATA_DIR` for artifact storage, and `SCOPE_CONNECTION_FILE` for discovery. The artifact directory defaults to `artifacts` under the selected Electron data directory. The desktop and CLI must use the same connection file. `SCOPE_PORT` selects the loopback port, default `43120`; `0` lets the OS choose a free port and records it in the connection file. Isolate both data and connection files when running multiple development instances.

## Optional remote access

The Mac must be awake with Scope running. Expose its loopback publishing API through Tailscale Serve on an unused HTTPS port, preserving existing routes:

```sh
tailscale serve --bg --https=8450 http://127.0.0.1:43120
```

A remote CLI uses `SCOPE_ENDPOINT=https://your-mac.your-tailnet.ts.net:8450` and the desktop publishing token through `SCOPE_TOKEN_FILE` or `SCOPE_TOKEN`. Transfer the token privately through an existing SSH connection, and keep it outside Git. Supplying an explicit endpoint disables automatic local credential discovery.

The optional VM hub forwards the same API. Its private environment file requires `SCOPE_ENDPOINT` pointing to the Mac's HTTPS endpoint and `SCOPE_TOKEN` containing the same publishing token. `SCOPE_PORT` chooses the hub's loopback port, default `43120`.

```sh
vp exec node --env-file=/path/to/private/hub.env apps/hub/dist/main.mjs
```

Use Tailscale Serve for private access to that loopback listener if needed. A caller targeting the hub uses its endpoint and the same token. The hub has no database, content directory, queue, or replay. It returns 503 when it cannot reach Scope. Do not expose either listener through a public listener or funnel. Provider API keys belong only to the desktop.

## Existing artifact data

To reuse data from a previous hub installation, stop the old hub and Scope, then copy the complete artifact data directory to the Mac. Point `SCOPE_DATA_DIR` at that copy when opening Scope. The SQLite tables and content-file format are unchanged, so existing IDs and revisions are retained. Do not merge it into a nonempty library or run the old hub against the same directory. No data is copied automatically from a remote VM.

## Checks and current limits

Linux desktop tests require Xvfb and the Electron shared libraries. On Ubuntu, install `xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64`. The test command starts an isolated Xvfb display when necessary. Standard tests use real Electron with temporary local SQLite storage, the built CLI, an optional forwarding hub, and synthetic provider responses. They verify publication without connection setup, persistence after restarting Electron, and failure without replay while the desktop is unavailable.

`vp run ready` builds, runs Vite+'s format/lint/type checks, then runs the integration and Electron tests. Use `vp run test tests/desktop.test.ts` or `vp test run tests/artifacts.test.ts` for focused checks after building. `vp check --fix` explicitly applies formatting or lint corrections; the standard command never does so.

Artifacts are durable. Unsaved canvas edits are local to the current desktop process and need Save before quitting. HTML previews permit inline styles and embedded data images; scripts, external assets, forms, nested frames, and navigation are blocked. Markdown does not execute raw HTML or load remote images.

The desktop currently runs from a checkout. A signed Mac application bundle and its native Keychain acceptance check are still required before distributing releases. Linux tests do not establish that behavior. Local Codex/Claude providers, remote generation requests, session tools, and tool-size hooks are planned capabilities, not working settings.

SQLite and blob storage need a backup policy before storing irreplaceable work. Quit Scope before copying its artifact data directory, or use SQLite's online backup API and copy the referenced blobs. Do not copy only `scope.db` while a running desktop may have committed data in its WAL file.
