# Sketchpad plugin

The Sketchpad is one built-in Excalidraw canvas. Its listening control may send
room audio and canvas context to OpenRouter and apply validated diagram edits.
Keep provider calls and credentials in main; microphone capture stays in the
renderer. Listening starts off and stops when leaving the tab or closing Scope.

`view.tsx` owns editing, `load.ts` restores the saved draft, `reset.ts` owns
Reset canvas and its undo window, and `main.ts` registers the draft IPC
operations. The draft lives in `tab_drafts` for the Sketchpad tab only. Never
save or delete before the saved draft has loaded. An empty canvas has no row.
Keep Excalidraw's local serialization so deleted elements and unused images
leave storage.

Test through real Electron with synthetic drawings. Never trigger Open, Save to,
Export, or Save as image in tests; they open native file dialogs.
