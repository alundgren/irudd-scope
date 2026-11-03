# Sketchpad plugin

The Sketchpad is one built-in Excalidraw canvas for the person only. Do not add
CLI commands, HTTP routes, names, events, or skill guidance that let agents read
or change it.

`view.tsx` owns editing, `load.ts` restores the saved draft, `reset.ts` owns
Reset canvas and its undo window, and `main.ts` registers the draft IPC
operations. The draft lives in `tab_drafts` for the Sketchpad tab only. Never
save or delete before the saved draft has loaded. An empty canvas has no row.
Keep Excalidraw's local serialization so deleted elements and unused images
leave storage.

Test through real Electron with synthetic drawings. Never trigger Open, Save to,
Export, or Save as image in tests; they open native file dialogs.
