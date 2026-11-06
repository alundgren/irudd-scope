# Meeting canvas plugin

The Meeting canvas is a test build for one team. It must not merge to `main` in this
state: the Codex backend, the debug log and the bench tool exist only for testing.

The tab listens to the room, transcribes speech through OpenRouter and, when someone
says "Canvas, …", asks an edit model to create or change a named section on an
infinite canvas. Agents have no command, route or skill guidance for the tab; they edit
the HTML that Keep as HTML publishes.

- `contract.ts` holds the tab state, canvas, section, canvas op and IPC request
  schemas. A saved `page` from the first test build loads once as a canvas.
- `wake.ts`, `canvas.ts`, `page.ts`, `render.ts`, `diagram/`, `export.ts`, `prompt.ts`,
  `canvas.css` and `page.css` are pure code with no React, Electron or DOM imports, so
  the bench can use them. `wake.ts` finds requests in transcript chunks from clip timing
  the caller supplies; `canvas.ts` applies canvas ops and reuses `page.ts` for the
  blocks inside a section.
- `view.tsx`, `camera.ts`, `block-editor.tsx`, `side-panel.tsx`, `settings-popover.tsx`
  and `view.css` are the tab; `camera.ts` pans, zooms, drags sections and follows changes. `view.tsx` sanitizes rendered HTML with DOMPurify before
  it reaches `innerHTML`, because this window has the `window.scope` bridge. It keys
  blocks as `sectionId/blockId` and keeps voice undo entries apart from the person's
  undo stack.
- `loop.ts` feeds transcripts to the wake detector and queues edit calls in the
  renderer; `microphone.ts` captures clips with their speech timing.
- `main.ts` registers the `scope:meeting-*` IPC handlers, validates every input with
  the contract and keeps the OpenRouter key in main.
- `backends.ts` calls OpenRouter and the Codex CLI. It must not import Electron.
- `debug-log.ts` is prototype only. It appends JSONL to `meeting-canvas-debug.jsonl`
  in the desktop data folder (`SCOPE_DESKTOP_DATA_DIR` in tests) with mode 0600 and
  rotates to `.1` at 5 MB. Never log audio or keys.

`tools/meeting-canvas-bench.ts` replays the scripts in `tools/meeting-canvas-bench/`
through the wake detector and the backends, and writes canvases and timings outside the
repository. It removes `Name:` speaker labels and times lines at 2.5 words per second,
with a 2 second pause for each blank line. It reads the OpenRouter key only from
`OPENROUTER_API_KEY`.

`tools/meeting-canvas-wake-bench.ts` replays wake-word transcripts (`Name: text`
chunks with `.expect.json` files beside them) through the wake detector and the Codex
backend, several at a time, and writes per-request canvases and a replay player
(`tools/meeting-canvas-wake-replay.ts`) outside the repository. `--usage-cmd` runs a
command that prints the weekly Codex usage percent, and `--stop-at` ends the run there.

Test through real Electron with fake provider replies, as `tests/meeting-canvas.test.ts`
does. Never call live models in standard tests.

Visual style adapted from OpenGhost by ANDRETRIPOL (MIT), https://github.com/ANDRETRIPOL/OpenGhost.
