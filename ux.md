# UI decisions

Scope is a Mac workspace for inspecting artifacts left by coding agents and
editing diagrams. The selected artifact gets the window. One compact strip
contains open tabs and a search button on the right. Search opens a roomy
control panel so secondary actions take no permanent tab space. Prose has a
reading width; images, HTML, and diagrams use the available area.

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
artifact data, images, and HTML keep their authored content. The
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

Tabs show the artifact title and indicate unread updates. Selection has both a
tinted background and a solid marker. The strip shows as many tabs as fit at a
readable width. Overflow lives in a dropdown at the left, with a hidden-tab
count and unread indicator. It lists hidden tabs immediately; typing searches
all tab titles and kinds. Selecting a result moves that tab to the right end
and moves the leftmost visible tab into the dropdown. The selected tab stays
visible when the window narrows or new publications arrive.

New publications open in tabs without a fixed count limit. The first arrival
selects itself when no artifact is open; later arrivals keep the current
selection and appear unread. Arrivals wait while a creation tool is open.
Startup restores saved tabs and opens queued publications. Revisions update
unread indicators without changing selection. File content loads when first
selected and stays mounted afterward to preserve reading position and HTML
state. Diagram views stay mounted to receive background editing commands.
The visible tab count does not bound memory used by previously visited content
or diagrams.

Closing a tab permanently deletes its artifact, draft, conversation, and tab
state. Normal close controls and Command-W perform deletion directly. There is
no closed history or reopen action. A failed deletion keeps the tab visible
with an error so the same close action can be retried. Quitting Scope, closing
the last window, updating, and restarting preserve tabs left open. SQLite
retains open and queued tabs, selection, and group membership. Each
tab has its own UUID and belongs to a group with an owner reference. Group
membership has no visual indicator. The desktop opens published items in its
local workspace group. File views and the diagram editor are built-in plugins;
existing image, Markdown, HTML, text, and download views remain together.

The Mac window combines its native window buttons and tabs in one draggable
strip, without a separate title bar. The application menu stays available for
native editing shortcuts. Windows and Linux hide the menu bar until Alt is
pressed. The macOS menu bar belongs to the system and follows its fullscreen
visibility setting.
File offers Save a copy for the active diagram, creating a separate tab with
the current canvas, including unpublished edits. View offers Fit to canvas.
Both actions target the visible proposal when one is open and are unavailable
on file tabs.

Fullscreen in the search panel enters native fullscreen, keeps the selected
artifact mounted, and hides workspace navigation. Other artifact tabs leave a
small exit at the top right, clear of Excalidraw's centered toolbar.
Diagram tabs start in Edit, with the Excalidraw tools and left menu available.
A small control at the top right switches between Edit, View, and
Present or exits fullscreen. View shows only the drawing and allows zoom and pan.
Present adds a larger pointer with a short trail for an audience. View and
Present prevent edits and hide the diagram conversation without discarding it.
Switching modes preserves the canvas, zoom, draft, and conversation. Escape
closes an active dialog or editor interaction, then returns View or Present to
Edit and Edit to the workspace. Command-Shift-F toggles fullscreen; Command-K
opens the panel in any mode. Leaving native fullscreen also restores the
workspace controls.

Published HTML is trusted agent output. Prototypes run their scripts, load
external resources, submit forms, and open links without a trust prompt or
preview restrictions. The document keeps its own styling and browser behavior.

Search opens with labeled icon controls for Settings, Fullscreen, creation
tools. A tinted current-tab area shows the title
and its Download, Artifact details, and Close tab actions. Unavailable actions
are omitted. Workspace controls and current-tab actions have distinct areas.
Artifact results appear only after typing, alongside matching actions and
specific settings. There is no closed-tab action or shortcut.
The panel scrolls in short windows and stacks its controls in narrow windows.
Settings opens with its search input focused and its sections collapsed.
Each section has a short description and can be expanded with the mouse or
keyboard. Search opens matching sections; clearing it returns to the compact
overview. Fields keep unsaved input when collapsed or filtered out. The search
field and top-right close button stay visible while the sections scroll. Empty results
offer Clear search and return focus to the search field.
Appearance saves when changed. The API key has its own Save key action inside
Diagram generation.
Diagram generation is off by default, including for existing profiles. Its
switch saves immediately. Turning it off retains the saved key and diagram
drafts. Create diagram offers a link to its Settings section while it is off.
Ask agent and the embedded conversation are hidden until generation is enabled,
except that named diagrams always offer their external coding-agent conversation.
Existing diagrams remain editable.
The diagram provider, model, and API key stay together. OpenRouter with Gemini
3.8 Flash is the supported configuration. Saving a key clears the input;
saved secrets are never displayed. Keychain errors remain visible while
Settings stays usable and offer Retry key access. Scope reads the provider
key only for a generation request, key changes, or when the enabled Diagram
generation section opens, including through search. Startup, folded or filtered
sections, and unrelated preference changes do not check provider credentials.

App updates and Agent tools are searchable Settings sections. Installed apps
check `main` when opened and build changed commits locally in the background.
A prepared update offers Restart to update without taking over the current
artifact. Restart uses the normal save-before-quit flow. Build failures keep
the current app available and show details with Retry; pending builds offer
Cancel. Checkout launches explain that automatic updates require installation.

Signing certificate is a searchable Settings section. It offers optional local
signing to reduce repeated Keychain prompts, with certificate creation
instructions and a button to open Keychain Access. Users connect an existing
certificate by name or fingerprint. Scope builds a copy and offers Restart to
apply; the current app keeps working until then. The connected certificate is
visible and can be replaced or disconnected. Certificate creation and private
key approval stay in macOS. Disconnecting never removes a certificate from
Keychain. Failed and canceled builds leave the current identity in use.
The first credential access may ask the user to approve **Scope Credentials**.
Settings names this helper and explains **Always Allow**, so the system dialog
is recognizable. Ordinary updates retain that permission by reusing the helper.
Changes to the helper or certificate and a locked Keychain can still prompt.

Agent tools provides separate CLI and global skill installation actions with
pending, installed, and failure states. The CLI follows the active app build.
The skill action uses npx skills for Codex and Claude Code. Each installed
tool has a removal action, and failed installation leaves a useful retry.

Remotes is a searchable Settings section. Installation happens on the remote
through the standalone CLI. The Mac pairs by accepting a pasted URL, shows
the destination before pairing, and clears the input after saving its credential.
Stored credentials are never displayed. Each hub pairs with one Mac; a Mac can
keep several independent remote records.

Enabled remotes connect when Scope starts and reconnect after a lost connection.
Disconnect persists until Connect is chosen. Remove remote revokes access on
the hub; when the hub is unreachable, Scope keeps a disconnected record with
a retryable error. Pairing and connection errors leave the workspace usable.
Publishing needs an awake Mac with Scope open. Offline work is not queued.

The installed Mac updates connected remotes to its running version after it
restarts. Offline remotes catch up on connection; disconnected remotes remain
off. Each remote shows update progress separately from its connection status.
Failures offer Retry update without interrupting the workspace. Older hubs
explain the one-time installer and setup step needed for automatic updates.
An accepted remote update can finish after disconnecting from the Mac.

Create diagram is available in the empty workspace and search panel.
An existing diagram has an Ask agent conversation, closed by default.
It sits beside the canvas at desktop widths and overlays it in a narrow
window. Enter sends, Shift+Enter adds a line, and a pending request offers
Cancel. Canvas edits save automatically to the artifact in SQLite, alongside
the conversation and view position. The editor has no Save button.
Its left menu contains Save a copy, Fit to canvas, Export, Find on canvas, Library, and Ask agent. The menu replaces the separate Library and
Ask agent controls on the right.

Named diagrams default their conversation recipient to Your coding agent. The
panel displays the stable name with Copy name and can switch to Scope diagram
agent. An external coding session receives human messages and canvas-edit
notices through a separately connected listener. A disconnected listener does
not prevent editing. Scope's embedded generation acts on the human's behalf.

An external agent can propose a reconciled diagram. Its editable preview covers
the original canvas and provides Accept proposal and Reject proposal. Accept
uses the edited preview and checks that the original has not changed. A stale
proposal stays visible with an explanation and can be rejected before the agent
reconciles again. The original canvas stays mounted underneath. Proposals and
the selected recipient persist with the tab and are deleted when it closes.
The editor's bottom-right help button is hidden because its shortcut reference
includes commands unavailable in Scope.

The conversation has one Send to selector. Scope diagram agent uses the configured
model. Connected agent sends requests to a publisher that has explicitly
connected and is waiting, even when embedded generation is off. Ask agent stays
available in that case so the person can choose Connected agent. The panel
shows the connection name and waiting or working state. With no connected agent
it explains how to make one available. Replies appear in the conversation and
canvas edits save automatically. Cancel ends that request and invalidates late
replies. Selecting Connected agent is temporary. Restart returns to the last
saved Your coding agent or Scope diagram agent choice; connection state does
not survive restart.

SQLite retains the conversation, unsent prompt, working canvas, and zoom and
pan across restarts for tabs that remain open. Incoming revisions preserve pending
edits and offer Use incoming version or Keep both. Failed saves retain the canvas
and offer Retry. Scope provides diagram conversation,
not general chat or agent orchestration.

New diagrams fit and center when first displayed. Background publication and
editing can continue before a canvas has visible dimensions. A draft without a
viewport fits on first display, including after restart. Adding the first agent
objects to an empty diagram also fits them. Later navigation and ordinary edits
keep the saved view. Fit to canvas recovers a view that was saved offscreen.
The editor's 10% minimum zoom still applies to very large drawings.

English text, keyboard navigation, visible focus, labeled icon controls, and
readable contrast apply throughout the workspace. Check long titles and more
tabs than fit on a Mac laptop or external monitor.
