# Diagram plugin

`renderer.tsx` registers the editor and creation tool. `view.tsx` owns editing;
`create.tsx` owns generation of a new published diagram. `main.ts` registers
provider, publication, and draft IPC operations. `provider-settings.ts` owns
the configured model. `contract.ts`, `scene.ts`, and `canvas.ts` own validated
semantic operations and Excalidraw conversion.

Drafts remain keyed by artifact ID in `desktop.db`. Preserve canvas, conversation,
unsent prompt, and viewport through close and restart. Publishing a revision
is separate from saving a draft. Incoming revisions and failed writes must
retain local edits. Cancel pending work on unmount and desktop shutdown.

Keep stable element IDs through conversions. Validate a complete operation
batch before changing the canvas. Standard tests use synthetic provider
responses and require no model credentials.
