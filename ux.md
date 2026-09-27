# UI decisions

Scope is a Mac workspace for inspecting artifacts left by coding agents and
editing diagrams. The selected artifact gets the window. One compact strip
contains the workspace menu, open tabs, search, and focus. Secondary actions
appear on demand. Prose has a reading width; images, HTML, and diagrams use
the available area.

## Appearance and controls

Scope uses Excalidraw-inspired cool neutrals, violet selection and focus,
rounded controls, and system typography. This keeps the workspace consistent
with its embedded editor and Mac appearance. It deliberately differs from
the house warm palette and IBM Plex fonts. The white light canvas, dark
neutral canvas, and higher text contrast follow that editor treatment.
Control text is smaller than reading text so the tab strip leaves room for
artifacts. Actual values belong to [tokens.css](apps/desktop/src/renderer/tokens.css).

System, Light, and Dark are supported because Scope sits alongside other Mac
apps and follows native appearance. Excalidraw follows the selected appearance;
artifact data, images, and isolated HTML keep their authored content. The
appearance picker uses a styled native select to retain desktop keyboard and
platform behavior. Provider and model are plain text because each has one
supported value.

[Visual design](docs/visual-design.md) describes token roles and controls.
The [repo UX skill](.agents/skills/ux-guidance/SKILL.md) guides implementation
and review against the running desktop. The app icon is an open window with
a blue breeze on a pale sky-blue tile. Its compact artwork omits the circle
and uses thicker strokes. [Assets and export instructions](apps/desktop/resources/README.md)
live with the desktop.

## Workspace behavior

Tabs show the artifact title, scroll in one row, and indicate unread updates.
Selection has both a tinted background and a solid marker. New publications
open in tabs. The first arrival selects itself when no artifact is open;
later arrivals keep the current selection and appear unread. Arrivals wait
while a creation tool is open. Startup restores saved tabs without opening
older library items. Revisions update unread indicators without reopening
closed tabs or changing selection. At the 100-tab limit, further arrivals
remain available through search and the desktop asks the user to close a tab.
Closing a tab preserves the artifact and its diagram draft; reopening finds
the same artifact. SQLite
retains open and closed tab records, selection, and group membership. Each
tab has its own UUID and belongs to a group with an owner reference. Group
membership has no visual indicator. The desktop opens published items in its
local workspace group. File views and the diagram editor are built-in plugins;
existing image, Markdown, HTML, text, and download views remain together.

Focus keeps the selected artifact mounted, hides workspace controls and
diagram chat, and leaves an exit at the top center. It preserves scroll, zoom,
and conversation. Excalidraw uses zen mode. Escape closes an active dialog or
editor interaction before leaving focus.

Search finds artifacts, tools, and specific settings. Settings opens with its
search input focused and explains empty results. Appearance saves when changed.
The diagram provider, model, and API key stay together. OpenRouter with Gemini
3.8 Flash is the supported configuration. Saving a key clears the input;
saved secrets are never displayed. Keychain errors remain visible while
Settings stays usable.

App updates and Agent tools are searchable Settings sections. Installed apps
check `main` when opened and build changed commits locally in the background.
A prepared update offers Restart to update without taking over the current
artifact. Restart uses the normal save-before-quit flow. Build failures keep
the current app available and show details with Retry; pending builds offer
Cancel. Checkout launches explain that automatic updates require installation.

Agent tools provides separate CLI and global skill installation actions with
pending, installed, and failure states. The CLI follows the active app build.
The skill action uses npx skills for Codex and Claude Code. Each installed
tool has a removal action, and failed installation leaves a useful retry.

Create diagram is available in the empty workspace, search, and workspace
menu. An existing diagram has an Ask agent conversation, closed by default.
It sits beside the canvas at desktop widths and overlays it in a narrow
window. Enter sends, Shift+Enter adds a line, and a pending request offers
Cancel. Save explicitly publishes changes.

SQLite retains the conversation, unsent prompt, working canvas, and zoom and
pan across restarts and closed tabs. Incoming revisions preserve unsaved
edits and offer loading the latest content or saving a copy. Failed draft
writes retain the canvas and offer Retry. Scope provides diagram conversation,
not general chat or agent orchestration.

English text, keyboard navigation, visible focus, labeled icon controls, and
readable contrast apply throughout the workspace. Check long titles and more
tabs than fit on a Mac laptop or external monitor.
