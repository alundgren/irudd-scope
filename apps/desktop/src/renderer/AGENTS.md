# Desktop UI

Read the [repo UX skill](../../../../.agents/skills/ux-guidance/SKILL.md) for UI
changes and reviews. [UI decisions](../../../../ux.md) records product choices;
[visual design](../../../../docs/visual-design.md) maps controls to shared tokens.

`tokens.css` owns shared visual values. `style.css` maps them to component roles
and lays out the desktop. Reuse `components/ui/` controls. Keep arbitrary
palette values out of components. Artifact content and Excalidraw drawing
colors are separate from the control theme.

Call named operations on `window.scope`. Use type-only imports for main-owned
contracts; do not bundle main-process code into the renderer. Persist drafts
and preferences through the desktop API, with visible retry on failed writes.

`workspace.tsx` owns the workspace layout and navigation. `use-workspace.ts`
owns saved tabs and their close/save behavior. `use-artifact-library.ts` owns
library subscriptions and unread updates. `workspace-search.tsx` owns search
results and result navigation. Keep artifact views mounted when switching
tabs, focus mode, or dialogs so edits and view positions survive.

Inspect the changed flow in real Electron with synthetic data. Verify both
appearances, keyboard access, and the affected narrow-window and failure states.
