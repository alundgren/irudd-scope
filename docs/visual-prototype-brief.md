# Visual prototype coverage

The compact design in the [visual reference](excalidraw-style-study.md) is selected. Extend the [existing specimen](mockups/appearance-study.html) using the [repo UX guidance](../.agents/skills/ux-guidance/SKILL.md) and shared desktop tokens.

Use synthetic local data and mock actions. Keep the specimen independent of credentials, model calls, hooks, and backend services. It demonstrates appearance and interaction; the desktop remains the implementation to validate. Preserve the bundled resource notices.

When extending a flow, demonstrate the states it needs:

- Open, switch, close, and reopen artifacts, including twelve tabs, long titles, and a narrow window.
- Search artifacts, tools, and specific settings. Show empty results and a keyboard path.
- Receive a new artifact or revision without changing selection. Protect unsaved diagram edits with a visible conflict choice.
- Enter and exit focus without losing position or drafts. Keep the exit clear of editor controls.
- Open and close diagram conversation, submit and cancel, and preserve it across navigation.
- Add, replace, remove, and fail to save a fake key. Never send or persist the entered value.
- Show empty and unavailable-library states with useful actions, plus Markdown, images, isolated HTML, files, and editable diagrams at useful sizes.

Keep mock labels consistent with [architecture](architecture.md): the desktop owns artifacts and publication requires Scope to be running on an awake Mac. Optional session tools and future providers must not look implemented in the live app.
