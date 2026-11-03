# Meeting canvas plugin

The Meeting canvas is a test build for one team. It must not merge to `main` in this
state: the Codex backend, the debug log and the bench tool exist only for testing.

The tab listens to the room, transcribes speech through OpenRouter and asks an edit
model to change a page of blocks. Agents have no command, route or skill guidance for
the tab; they edit the HTML that Keep as HTML publishes.

- `contract.ts` holds the tab state, page, edit op and IPC request schemas.
- `page.ts`, `render.ts`, `diagram/`, `export.ts`, `prompt.ts` and `page.css` are
  pure page code with no React, Electron or DOM imports, so the bench can use them.
- `view.tsx`, `block-editor.tsx`, `side-panel.tsx`, `settings-popover.tsx` and
  `view.css` are the tab. `view.tsx` sanitizes rendered HTML with DOMPurify before
  it reaches `innerHTML`, because this window has the `window.scope` bridge.
- `loop.ts` paces clips and edit calls in the renderer; `microphone.ts` captures clips.
- `main.ts` registers the `scope:meeting-*` IPC handlers, validates every input with
  the contract and keeps the OpenRouter key in main.
- `backends.ts` calls OpenRouter and the Codex CLI. It must not import Electron.
- `debug-log.ts` is prototype only. It appends JSONL to `meeting-canvas-debug.jsonl`
  in the desktop data folder (`SCOPE_DESKTOP_DATA_DIR` in tests) with mode 0600 and
  rotates to `.1` at 5 MB. Never log audio or keys.

`tools/meeting-canvas-bench.ts` replays the scripts in `tools/meeting-canvas-bench/`
through the backends and writes pages and timings outside the repository. It reads the
OpenRouter key only from `OPENROUTER_API_KEY`.

Test through real Electron with fake provider replies, as `tests/meeting-canvas.test.ts`
does. Never call live models in standard tests.

Visual style adapted from OpenGhost by ANDRETRIPOL (MIT), https://github.com/ANDRETRIPOL/OpenGhost.
