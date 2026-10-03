# Diagram plugin

`renderer.tsx` registers the editor. `view.tsx` owns editing. `main.ts` registers
provider, publication, and draft IPC operations. `provider-settings.ts` owns
the configured model. `contract.ts` owns provider contracts. Public diagram operations are defined in
`packages/protocol/src/diagram.ts`; `scene.ts` validates their relationships and
`canvas.ts` converts them to Excalidraw elements. The command modules route
authenticated diagram requests to the loaded editor.

Drafts are keyed by tab UUID in `scope.db` and require an existing tab. Preserve
canvas, conversation, unsent prompt, and viewport while a tab remains open and
through application restart. Closing the tab deletes all of that state. Publishing a revision
is separate from saving a draft. Incoming revisions and failed writes must
retain local edits. Cancel pending work on unmount and desktop shutdown.

Keep stable element IDs through conversions. Validate a complete operation
batch before changing the canvas. Run `vp run test:diagram` only when diagram
plugin implementation changes. This suite is excluded from `ready`; use
synthetic provider responses and no model credentials.
