# UI decisions

Other Scopes pairs guest desktops through one five-minute, one-use invitation.
Main copies and reads the invitation through the clipboard; secrets and endpoints
never appear in renderer state. The receiving person reviews the named Scope and
allows sharing, then the issuer reviews the requesting Scope and approves.
Both endpoints are verified and both sides protect their pair credentials before
access begins. Cancel and expiry leave access off. Partial pairing reports a
failure and asks the person to forget any incomplete pair before starting again.
Guest pairing uses the installed Tailscale network.

Cancellation shows progress until consent and protected confirmation are revoked.
If either write fails, Other Scopes shows Retry cancellation and asks the person
to resolve it before restarting. It does not show cancellation as complete or
allow a new invitation to replace that failure. Local access stops immediately.

Saved compatible pairs retry automatically on startup, wake and outages without
another invitation. Status distinguishes setup, offline, denied access, connected
and incompatible versions. Disable revokes guest requests and sessions; Forget
removes guest credentials while preserving local references and recovery input.
A saved listener port conflict asks the person to close the conflicting app and
retry. Missing local interfaces, invalid destinations and denied connections have
separate errors. Changed endpoints require forgetting the peer and pairing again;
retry never silently changes the saved endpoint. Retry connection is hidden while
connected or connecting.

Eligible owner tabs appear automatically after guest sharing connects, including
hidden bookmarked files, plans and folders. Guest tabs show one small accent monitor
icon before the title, without an owner-name prefix or an extra button. Hover or
keyboard focus shows the full title, owning Scope and connection status when unavailable.
The drawer's existing detail line names the kind and owner, and search matches the owner.
Fullscreen moves the indicator to the existing controls, keeping one marker visible.
Healthy guest content starts directly below navigation. Search and controls names the owner in its current-tab area
and contains source actions. File guests use the existing viewers and Download action. Plans and
folders use their registered native views and preserve their kind. Older builds
without the required capability show an update requirement. Unavailable sources show a status message and hide the document
from interaction. Offline, disabled, unpaired and incompatible connections have
distinct recovery advice. An absent source may have expired, moved to Trashcan,
or become ineligible; checking the source belongs on its owner.
Close hides a guest locally; guests have no local bookmark or Trashcan action.
Source actions name the owner and separately offer source title changes, retention
and moving the source to the owner’s Trashcan. Stale changes retain entered input
and show the current owner revision. Uncertain operations block further source
changes until status and current source are reviewed; reconnect does not resend writes.
Failed guest content reads offer Retry content in the tab. Retrying does not
require closing the tab or changing the source revision. Successfully loaded
views retain their interactive state when hidden and reopened. Mixed local/guest
order, selection, hidden state, unread revisions and file reading position survive
restart in receiver SQLite. Catalog refreshes preserve navigation and never take
selection from the current tab. Guest visibility does not extend owner retention.

During temporary unavailability, loaded HTML stays mounted but hidden and inert.
A current accepted catalog for the same owner, source, revision and blob is required
before showing it again. A changed revision loads current owner bytes. Hidden HTML
is still trusted executable content; hiding does not suspend scripts. Runtime state remains in memory only. Supported edited form fields have separate
bounded receiver recovery records and survive restart. Form input recovery appears
in Search and controls only when saved or working input exists or recovery fails.
Real failures show a compact action to review recovery; editing never opens the
panel automatically. Opening or closing the panel preserves the document and drafts. Restore saved fields is
explicit and requires the same owner, source, revision and blob. Changed documents
keep old input available for copy or discard. Passwords, files, sensitive fields,
ambiguous identifiers and arbitrary script state are excluded; unsupported fields
never promise persistence. Scope stores no persistent guest HTML snapshot.

Scope is a macOS and Windows 11 x64 workspace for inspecting artifacts left by coding agents and
reviewing structured plans, with a personal Sketchpad for ideas. The selected artifact gets the window. One compact strip
contains open tabs and a search button on the right. Search opens a roomy
control panel so secondary actions take no permanent tab space. Prose has a
reading width; images, HTML, and the Sketchpad use the available area.

## Appearance and controls

Scope uses Excalidraw-inspired cool neutrals, violet selection and focus,
rounded controls, and system typography. This keeps the workspace consistent
with its embedded editor and native appearance. It deliberately differs from
the house warm palette and IBM Plex fonts. The white light canvas, dark
neutral canvas, and higher text contrast follow that editor treatment.
Control text is smaller than reading text so the tab strip leaves room for
artifacts. Actual values belong to [tokens.css](apps/desktop/src/renderer/tokens.css).

Scope and Excalidraw controls share primary and secondary text colors so menus,
hints, and keyboard shortcuts stay readable in both appearances. Drawing colors
remain as authored.

System, Light, and Dark are supported because Scope sits alongside other desktop
apps and follows native appearance. Excalidraw follows the selected appearance;
artifact data and images keep their authored content. HTML tabs and Folder
HTML previews without their own `color-scheme` meta get the selected appearance
as their default color scheme, so a plain page reads dark in Dark mode and
switches without reloading. Colors and `color-scheme` the page sets itself still
win, so a page that sets dark text without a background is hard to read in
Dark mode. The appearance picker uses a styled native select to retain desktop
keyboard and platform behavior. Provider and model are plain text because each
has one supported value.

[Visual design](docs/visual-design.md) describes token roles and controls.
The [repo UX skill](.agents/skills/ux-guidance/SKILL.md) guides implementation
and review against the running desktop. The app icon is an open window with
a blue breeze on a pale sky-blue tile. Its compact artwork omits the circle
and uses thicker strokes. [Assets and export instructions](apps/desktop/resources/README.md)
live with the desktop.

## Workspace behavior

Tabs show the artifact title and indicate unread updates. Selection has both a
tinted background and a solid marker. The strip shows as many tabs as fit at a
readable width. The left drawer button counts all active tabs, including those
outside the strip, and excludes tabs in Trashcan. The drawer starts with
title/name/kind search and All, Permanent, and Temporary filters. It lists active
tabs in saved strip order, without a heading, repeated status icons, or per-row
trash actions. A subdued Trashcan link sits below the list without a count,
since recovery is infrequent.
The drawer remains available even when every tab fits or no active tabs remain.
Selecting a result keeps its saved position. The selected tab stays visible
when the window narrows or new publications arrive.

Drag tabs in the strip or drawer to reorder them. An insertion line marks the
drop position. Both use one saved order; filtering does not change other tabs'
relative order. Holding a dragged tab over the drawer button opens it. Dropping
onto the Trashcan link moves the tab there. A focused title also supports Alt
and arrow keys to reorder, or Delete to move to Trashcan. Selecting a tab or
changing its permanence does not reorder it.

New publications open in tabs without a fixed count limit. The first arrival
selects itself when no artifact is open; later arrivals keep the current
selection and appear unread.
Startup restores saved tabs and opens queued publications. Revisions update
unread indicators without changing selection. File content loads when first
selected and stays mounted afterward to preserve reading position and HTML
state. The Sketchpad also loads on first selection and stays mounted.
The visible tab count does not bound memory used by previously visited content.

New tabs are temporary. Plans start permanent. A small bookmark button keeps a
tab permanently; a filled bookmark indicates permanence. It appears on hover,
keyboard focus, and the selected tab, and stays visible on permanent tabs. The
drawer places this toggle beside the title, showing it on hover or keyboard
focus and keeping permanent bookmarks visible. The toggle is also available
in the current-tab search controls.
Turning permanence off starts a fresh one-day allowance.

Temporary tabs move to Trashcan after 24 hours outside the visible strip. The
selected artifact counts as visible in fullscreen. A minimized or hidden window
does not keep refreshing visibility. Scope checks on startup and every minute
while running, after flushing pending saves. A long offline interval starts a
full seven days in Trashcan when the tab is actually moved there.

Close controls, Command-W on macOS, and Ctrl+W on Windows move temporary tabs to Trashcan. For permanent
tabs, they move the tab to the end of the saved order, last in the drawer,
and select a neighboring tab. Closing a background permanent tab keeps the
current selection. Closed permanent tabs leave the strip and stay closed after
restart, even when room is available. Their content stays mounted while Scope
runs. Selecting one from the drawer reopens it with the same UUID and saved
position. Closing the last visible tab leaves no selection. Delete, dropping
onto Trashcan, and the explicit Move to Trashcan action still trash ordinary
temporary and permanent tabs.

Built-in tabs are always permanent. A noninteractive lock icon identifies them
in the strip and drawer. They have no permanence toggle. Close, Delete, and
dropping onto Trashcan hide them for reopening from the drawer; these actions
never delete their data. Artifact details show a saved name beside the ID when
the artifact has one.

Closing or trashing ordinary artifact tabs preserves
artifact content, names, drafts, conversations, and saved viewport. Agent updates cannot restore
trashed tabs or refresh their retention clocks. Restore returns the same tab to
the right end, selects it, preserves its permanent setting, and restarts the
one-day allowance for temporary tabs. Trashcan sorts newest first and shows the
remaining retention time. It permanently deletes tabs after seven days there.
Empty Trashcan expands an inline warning, requires a slider and a separate
Delete button, and resets when canceled, closed, or the trash contents change.
Opening the confirmation focuses its slider; Cancel returns focus to Empty Trashcan.
The confirmation covers the whole trash, even when search hides some entries.
A failed save or retention action leaves a visible error and a retry path.

Quitting Scope, closing the last window, updating, and restarting preserve
active and trashed tabs. SQLite retains retention, selection, and group
membership. Each tab has its own UUID and belongs to a group with an owner
reference. Group membership has no visual indicator. The desktop opens
published items in its local workspace group. File views and the Sketchpad
are built-in plugins; existing image, Markdown, HTML, text, and download views
remain together. The explicit CLI/API delete command still deletes permanently.

The Mac window starts maximized to fill the available desktop area, keeping
the menu bar and Dock available. It uses one draggable tab strip without a
separate title bar. Native window buttons are hidden so their space is available
for tabs. The application menu keeps window commands and native editing
shortcuts available. Windows keeps its native title bar and minimize, maximize,
and close buttons. Windows and Linux hide the menu bar until Alt is pressed.
Shortcut labels and keyboard matching use Ctrl on Windows and Linux and Command
on macOS. Closing the last window quits on all platforms, after pending saves
finish; there is no background tray or service mode.
The macOS menu bar belongs to the system and follows its fullscreen visibility
setting.
View offers Fit to canvas while the Sketchpad is selected.

Fullscreen in the search panel enters native fullscreen, keeps the selected
artifact mounted, and hides workspace navigation. Other artifact tabs leave a
small exit at the top right, clear of Excalidraw's centered toolbar. Dragging the
frame around Scope's fullscreen controls moves them away from content. The
focused frame accepts arrow keys, with Shift for larger steps, and Home restores
the default position. Positions are saved per tab and stay within the window
when it narrows.
The Sketchpad starts in Edit, with the Excalidraw tools and left menu available.
A small control at the top right switches between Edit, View, and
Present or exits fullscreen. View shows only the drawing and allows zoom and pan.
Present adds a larger pointer with a short trail for an audience. View and
Present prevent edits. Switching modes preserves the canvas, zoom, and draft. Escape
closes an active dialog or editor interaction, then returns View or Present to
Edit and Edit to the workspace. Ctrl+Shift+F toggles fullscreen and Ctrl+K opens
the panel on Windows; macOS uses Command-Shift-F and Command-K. Ctrl+, on Windows
or Command-, on macOS opens Settings. These work in any mode. Leaving native fullscreen also restores the
workspace controls. Ordinary HTML, plans, and PR inboxes offer View, Present,
and Back to tabs in fullscreen. Present uses the same audience pointer and
trail inside accessible HTML frames while links, forms, scrolling, and scripts
remain usable. Embedded frames at another origin retain the native cursor.
Scope does not override Escape in editable fields, open page dialogs, or events
the page handles. Otherwise Escape returns HTML Present to View, then returns
to the workspace.

Published HTML is trusted agent output. Prototypes run their scripts, load
external resources, submit forms, and open links without a trust prompt or
preview restrictions. HTTP(S) links and popups open in the system's default
browser, preserving the artifact and unsaved input in Scope. In-page anchors,
downloads, and forms targeting embedded frames stay in the document. If the
browser cannot open, the artifact stays in place. The document keeps its own styling.

Search opens with labeled icon controls for Import tab, Settings, and Fullscreen. A tinted current-tab area shows the title
and its Download, Artifact details, retention toggle, and Move to Trashcan actions. Unavailable actions
are omitted. Workspace controls and current-tab actions have distinct areas.
Artifact results appear only after typing, alongside matching actions and
specific settings. Trashed tabs appear only in the left drawer.
The panel scrolls in short windows and stacks its controls in narrow windows.
Settings opens in a large dialog that uses most of the window height, with its
search input focused and its sections collapsed. Drag its title bar to move it
and its edges or corners to resize it. The title-bar grip and bottom-right resize
control also accept arrow keys, with Shift for larger steps. The dialog stays
inside the window, including when the window gets smaller, and keeps its adjusted
size and position when reopened during the same app session.
Each section has a short description and can be expanded with the mouse or
keyboard. Search opens matching sections; clearing it returns to the compact
overview. Fields keep unsaved input when collapsed or filtered out. The search
field and top-right close button stay visible while the sections scroll. Empty results
offer Clear search and return focus to the search field.
Appearance saves when changed. Voice generation is a searchable section, off by
default. It uses a sliding switch
beside a fixed setting name, with adjacent On or Off text showing the current
state. Thumb position and color also distinguish the states. The switch saves
immediately, and turning it off retains the shared key. Voice generation shows the fixed Gemini 3.8 Flash TTS model
and the default Aoede voice and explains that submitted requests may still incur
a charge. New requests use restrained conversational solo delivery. The agent
guide also provides a two-speaker conversation with Aoede leading and Leda
replying; agents choose each turn's voice and instructions and join the exports.

OpenRouter is a separate searchable Settings section for the shared API key.
It remains usable when voice generation is off. Saving a key clears the
input; saved secrets are never displayed. Removing the key affects both
features. Credential errors remain visible while Settings stays usable and offer
Retry key access. Scope reads the provider key for generation, billing lookup,
key changes, or when the OpenRouter section opens, including through search.
Startup, folded or filtered sections, and unrelated preference changes do not
check provider credentials. The section names macOS Keychain, Windows DPAPI, or
session-only storage according to the active credential mode, including explicit
session overrides. Feature sections display their fixed provider and
model, while the shared-key section explains which features use the key.

App updates and Agent tools are searchable Settings sections. Installed apps
check `main` when opened and build changed commits locally in the background.
A prepared update offers Restart to update without taking over the current
artifact. Restart uses the normal save-before-quit flow. Build failures keep
the current app available and show details with Retry; pending builds offer
Cancel. Checkout launches explain that automatic updates require installation.

Signing certificate is a searchable Settings section on macOS. It is omitted
on Windows and Linux. It offers optional local
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
pending, installed, and failure states. The CLI and bundled Scope skills
follow the active app build. Skills install locally for Codex and Claude Code
without a network request. Startup migrates registered older Scope copies
with backups and repairs incomplete managed links. Separate installations
remain untouched, with their path and recovery instructions in Settings.
The installed skill action is Repair skill; the section explains automatic
updates and refreshing or starting an agent session to reload guidance.
Each installed tool has a removal action. Removed skills stay uninstalled
across app updates, and failed installation leaves a useful retry.

Remotes is a searchable Settings section. Installation happens on the remote
through the standalone CLI. The desktop pairs by accepting a pasted URL, shows
the destination before pairing, and clears the input after saving its credential.
Stored credentials are never displayed. Each hub pairs with one desktop; a desktop can
keep several independent remote records.

Enabled remotes connect when Scope starts and reconnect after a lost connection.
Disconnect persists until Connect is chosen. Remove remote revokes access on
the hub; when the hub is unreachable, Scope keeps a disconnected record with
a retryable error. Pairing and connection errors leave the workspace usable.
Direct publication needs an awake desktop with Scope open. Paired hubs buffer
offline file and text publications for up to 48 hours, capped at 50 tabs.
Queued receipts identify pending delivery and expiry. The CLI can inspect or
discard queued entries. Conflicts remain inspectable and never overwrite
newer desktop content. Interactive operations still require a connected desktop.

The installed desktop updates connected remotes to its running version after it
restarts. Offline remotes catch up on connection; disconnected remotes remain
off. Each remote shows update progress separately from its connection status.
Failures offer Retry update without interrupting the workspace. Older hubs
explain the one-time installer and setup step needed for automatic updates.
An accepted remote update can finish after disconnecting from the desktop.
Skill errors remain visible even when the CLI and hub match the desktop. Details
identify the conflicting path and recovery commands; Retry update rechecks the
skill without rebuilding tools already at the requested commit. A completed
skill update reminds the person to refresh or start a new agent session.

Coding agents create plans and PR inboxes through the publication commands.
Search and the empty workspace offer no manual creation controls for them. The
empty workspace shows existing artifacts or an example publication command.
Published `.excalidraw` files open as downloadable files.

## Folder tabs

Only agents open Folder tabs, when the person asks them to share a folder.
Scope has no Open folder button, menu item, or folder drop target, so the strip
and menus stay unchanged. A new Folder tab follows publication rules: it
appears unread at the end of the strip and selects itself only when no tab is
selected. Reopening an existing tab marks it unread, renames it when the agent
passes a new title, and returns a closed or trashed tab to the end of the
strip without changing selection, even when nothing is selected.

When the person asks to see a file, the agent runs `folder select`. Scope
opens the folder's tab if needed, expands every folder down to the file, and
selects it in the tree, scrolled into view when the tab is shown. With
`--lines`, the preview shows the file's text with those lines highlighted:
centred when they fit, otherwise starting at the first. Choosing another file
clears the highlight. The tab is
marked unread and the selected tab does not change. A file outside the folder
or missing fails in the agent's shell and changes nothing in Scope.

Every Folder tab starts with a folder icon, so a shared folder is easy to tell
apart from a published file. A local Folder tab then shows its title. A remote
Folder tab shows the machine name in the accent color, then `·` and the title;
only the title is shortened with an ellipsis. The tooltip
lists the full title, the machine (This Mac, This PC, or the remote's name),
and the full path. The drawer's second line is the folder name, with the
machine first for remotes, and drawer search matches the title, machine, and
folder name.

Inside the tab, a top bar shows a machine chip for remotes, the full path, a
Show ignored files checkbox, and Copy path. The tree lists folders before
files, each sorted by name, and renders only visible rows. `.git` is always
hidden. Ignored files are hidden by default and dimmed when shown. Links that
point outside the folder show a link icon and do not open. Changes on disk
appear without losing scroll position, expanded folders, or the selected file,
also when a folder is replaced or ignore rules change.
A deleted selected file stays in the tree, struck through and marked Deleted.
When a Linux machine runs out of file watches, the tab says live updates are
slower. A missing folder shows `This folder no longer exists`, its path, and
Close; the tree returns if the folder comes back. An offline remote shows
`NAME is offline` with the path and no cached files. A remote whose hub lacks
folder routes shows `Update Scope on NAME to view this folder`; other remote
errors, such as a folder the hub may not read, show the error instead. Links
into `.git` count as pointing outside the folder.

Files and Search buttons sit above the tree. The filter box shows every file
whose path contains its text, in any letter case, with parent folders open and
everything else hidden. Closing a folder while filtering does not change the
saved expanded folders, so clearing the filter restores the previous tree. The
filter text survives restart. While Scope still lists the folder, the filter
says `Still scanning…`; for folders with more than 200,000 paths it says that
it asks the folder's machine instead, and asks again when files change. It
shows at most 10,000 files and says so. An agent's `folder select`, a drop, or a
search match reveals its file each time, even when it is already selected: the
folders down to it open in the tree shown, including folders closed while
filtering. When the filter would hide the file, the tree shows all files and says
`Showing all files so NAME is visible.`, naming the selected file, with Filter
again. Selecting other files keeps all files shown. The filter text stays in the
box; editing it or Filter again filters the tree again, and Filter again returns
focus to the box. A tab first shown after restart reveals its saved selection,
because an agent may have selected it meanwhile.

Search looks through file contents on the folder's machine and lists each match
as path, line number, and the line with the match marked. It skips binary files
and files over 1 MiB, follows Show ignored files, stops at 1,000 matches with a
note, and has Cancel while running. A new query cancels the previous one.
Switching between Files and Search keeps both. Clicking a match selects the file
and scrolls its preview to that line.

Selecting a file shows a preview beside the tree, below it in narrow
windows, using the published-file viewers. The preview bar's expand button hides
the tree and the folder bar so the preview fills the tab; the same button or
Escape outside a text field brings them back. With Fullscreen the preview fills
the screen. Text has line numbers, and code is
coloured by its file name in both appearances; files over 2 MiB and lines over
2,000 characters stay plain. Markdown and HTML have a Source button, which a
search match or an agent's marked lines turn on. HTML previews are
trusted and run like published HTML, with scripts, forms, popups, and external
resources enabled and no iframe sandbox. Files Scope cannot
display show name, size, and modified time. Text over 2 MiB shows its first
2 MiB with a note. A file that changes reloads; a file that is deleted, or whose
folder is renamed or deleted, says `This file was deleted.` Published text files
show line numbers too, and Select All copies the whole text.

Text, Markdown, and HTML files up to 2 MiB have Edit in the preview bar, on this
computer, on remotes, and in guest folders. Edit replaces the preview with the
file's text; Save, or Ctrl+S (Command-S on macOS), writes it to the folder's
machine, keeping the file's line endings and byte order mark. Done returns to the
preview, and becomes Discard while there are unsaved changes. Unsaved text stays
only in the open tab, across switching files and tabs, and the tree marks such
files Edited. Closing a permanent or guest tab to the drawer keeps them. Moving
the tab to Trashcan or quitting Scope with unsaved changes is refused, with a
note naming the files, until they are saved or discarded. A file that
changes on its machine while unedited reloads in the editor. With unsaved
changes the editor keeps the text and says the file changed, offering Reload and
discard my changes or Overwrite with my changes; Save stays off until one is
chosen. A save that finds the file changed is refused the same way, so a newer
file is never replaced silently. A deleted file says so, and Save creates it
again. A remote whose hub lacks versioned folder operations asks for an update.

Dragging files from Finder or Explorer over the tree outlines the folder under
the pointer. Over a file it copies into that file's folder, and over empty space
it outlines the whole tree for the top folder. Dropping copies the files, and
dropped folders with their contents except `.git`, onto the folder's machine; the originals
stay put. The tree then selects the first new file. A name that already exists
asks `NAME already exists in FOLDER` with Replace, Keep both, and Cancel, and so
does a second dropped file or folder with the same name. Keep
both adds a number, as in `notes 2.md`; Cancel stops the whole drop before
anything is written. With several existing names the question offers Apply to
all. A name that appears while files are copied asks again instead of
overwriting. Right-clicking a file shows Save to computer…, Copy path, and, for
folders on this computer, Reveal in Finder (Show in Explorer on Windows);
folders offer the last two. Save opens the normal save dialog in Downloads with
the file's name. Files Scope cannot preview also show a Save to computer…
button. Saves and drops show a progress row with Cancel above the tree. A
cancelled or failed transfer leaves no partial file, and a failure stays shown
until dismissed. If a dropped file's path leads to a different file by the time Scope copies
it, for example because it was replaced while Scope asked, it is not copied and
the row says to drop it again. Edits to the same file are copied.

Guest folders use the same tree, filter, search, previews, replacement questions,
save dialog and progress controls through their owner. The tab indicator identifies
the owning Scope; hovering the folder title also names its remote. The folder bar
does not repeat the owner or show the owner's root as a local path.
Copy path on a guest file copies its relative path. New folder creates a
relative directory through the owner. Reading and selection stay local to the
receiver and survive restart independently of the owner's navigation.

A pending or interrupted guest write retains its original file reference and
shows Check upload status. It never retries automatically. Conflicts preserve
the original input. A recorded outcome can be cleared after refreshing the
folder; an unknown outcome requires checking the destination and an explicit
acknowledgement. Recovery remains visible while the owner is unavailable.
Status can be checked while an upload or directory request runs, but its recovery
cannot be cleared until the request and cleanup stop. If a recorded result has
expired or becomes unknown when clearing, Scope keeps recovery and requires the
new destination-inspection action; the previous normal clear action does not
authorize that decision.
Updating an older peer or hub is required for unsupported operations. A hub-only
outage does not make other folders or owner artifacts unavailable.

## Sketchpad

The Sketchpad is one built-in Excalidraw canvas for the person's own ideas.
Search offers Sketchpad, matching words such as draw, whiteboard, and Excalidraw.
It opens the existing Sketchpad or creates it once. Like other built-in tabs it
is always permanent, and closing hides it for reopening from the drawer or
search. Agents have no command, API route, name, or skill guidance for it. To get
help with a drawing, the person saves it to a file from the Excalidraw menu,
hands that file to an agent, and opens the result again.

Its left menu keeps Excalidraw's Open, Save to, Export image, Save as image,
command palette, Find on canvas, Help, and canvas background, plus Fit to canvas,
Library, and Reset canvas. Theme follows Scope's appearance. Pasted images are
allowed. Drawings save automatically; there is no Save button. A failed save
shows Retry. A drawing over 32 MiB shows an error and asks the person to remove
an image.

Reset canvas clears the drawing immediately and shows "Canvas cleared." with
Undo for ten seconds. Undo, Command-Z, or Ctrl+Z in that time restores the
drawing. Drawing something new or opening a file ends the undo window and saves
the new canvas. When the time passes, the person leaves or closes the Sketchpad, or Scope
quits, Scope removes the stored drawing. An empty canvas takes no storage row.
The canvas library lasts for the current session. The editor's bottom-right help
button and sidebar trigger are hidden; the left menu offers both.

English text, keyboard navigation, visible focus, labeled icon controls, and
readable contrast apply throughout the workspace. Check long titles and more
tabs than fit on a laptop or external monitor.

## Harnesses

Harnesses is a permanent built-in tab that shows the coding agent tools on this
computer. Search offers Harnesses, matching words such as Codex, Claude Code,
Cursor, Grok, skills and MCP. It opens the existing tab or creates it once, like
the Sketchpad, and closing hides it for reopening from the drawer or search.
It is not created at startup: most people check their harnesses now and then,
and a startup tab would take strip space from artifacts.

The tab shows only skills and instruction files. Versions, sign-in, folder
sizes, MCP servers and agents stay in `irudd-scope harnesses read` and Copy as
JSON. Machine columns stay about 360 px wide so a cell reads as one block on a
wide window, and an empty last column takes the remaining width. The first
column is this computer, named This Mac, This PC or This computer; other machine
columns are compared with it. With one column nothing is compared. Each column
heading shows when its scan was made as relative time, such as just now, 5 min
ago or yesterday, refreshed every 30 seconds; the exact date and time is its
tooltip and screen reader text.

Skills has one row for each of Claude Code, Codex, Cursor and Grok Build, then
Shared skills for `~/.agents/skills`. A cell shows the number of the harness's
own skills as a quiet button without an underline. Codex's label adds "+ Shared
skills" when `~/.agents/skills` exists, because Codex documents that folder as
its user skill folder; other rows make no such claim. A harness that is not
found shows Not installed; a missing shared folder shows Not found, and a linked
shared folder shows Linked folder. Other machines add how their skill folder
names differ from this computer's: "2 missing", "1 extra", "1 missing · 1 extra"
or Same. Differences use the warning text color and Same stays muted, so the
words carry the meaning without color.

Selecting a count with the mouse, Enter or Space opens the skill names in a
panel below the row and keeps focus on the count; selecting it again, or the
panel's close button, closes it and returns focus to the count. One panel is
open at a time. A rescan that removes the opened harness or folder closes its panel. The panel heading shows the harness, its skill folder, a "↪
Linked" key when a listed skill is a link, and Copy as JSON for that harness on
that machine. Names that differ between machines come first, one row each with
a check or Missing per machine; names every machine has fold behind "N matching
skills". With one machine column the panel lists every name. A linked skill has
one ↪ after its name, with the accessible name linked; Scope never reads its
target. Bundled skills are not listed.

Instruction files has one row per harness and file path that any machine has,
labeled with the harness name and the path. A cell shows a short fingerprint,
then size and line count; the same fingerprint means the same text. Another
machine shows Different beside a fingerprint that differs from this computer's,
and Missing when this computer has the file and it does not. A linked file shows
Linked file. A line below names harnesses that are found but have no
instruction files, for example "Cursor has no instruction files.", and the
shared skill folder path. Sizes use decimal units like a file manager. The CLI
and Copy as JSON keep exact bytes.

The toolbar has Copy agent request and Rescan. The request asks the person's
agent to run `irudd-scope harnesses guide` and then `harnesses read`; Scope does
not run agents. Rescan shows Scanning… while it runs and updates the scan time.
A failed scan keeps the last scan visible and shows an error with Retry. The tab shows no folder sizes, so a failed size count shows no error. A scan
that cannot be saved is still shown. The first open without a saved scan shows
Scanning…; a scan that finds nothing names the folders it checked. After a
restart the saved scan shows at once and is replaced when the startup scan
finishes. There is no periodic scan and no action that opens or changes a
harness folder.

At narrow widths the matrix scrolls inside the tab. Long skill names wrap.

## Structured plans

Plans have an immutable unique name and start permanent. Later updates respect
the person's permanence choice. Overview gives the authored HTML the available
area beneath compact Overview and Work items controls. Trusted scripts and external
resources remain supported. Work items exposes outcomes, full owned checks,
prerequisites, related context and a copyable independent packet. It provides
inspection of every captured proposal, including those without agreement or evidence.
Each retained proposal exposes its original HTML and complete checks, with a return
to the current proposal. Inspection creates no agreement or evidence.
Recorded results are labeled as results on that proposal, not current verification.

Discussion stays in the coding session. There is no questionnaire, approval button
or forced prose sidebar. Authored plans use dark neutral presentation with strong
whole-scenario boundaries and visual checks where useful. Native controls follow
Scope appearance. Each full check procedure remains accessible. Tab switching and
hiding retain the document; current overview position and selected work view/item
survive restart. Updates retain the current reading position where content permits.
A plan guest uses this same native presentation. Its selected work item, retained
proposal and reading positions belong to the receiving desktop and survive restart.
Copy work item and the displayed retrieval command identify the owner device,
source tab and artifact, even when another desktop has the same plan name or ID.
These controls only navigate, inspect and copy. Owner writes remain agent CLI
commands in the existing conversation.
Legacy HTML plans become ordinary HTML tabs with their content and lifecycle intact.

## Pull request inboxes

Each inbox is a permanent named HTML app for one GitHub repository. The initial
app presents a flat list and named views, with no search or sort controls.
Agents can replace its HTML and JavaScript while Scope preserves the current
PR data, notes, snoozes, and review decisions. Inboxes are built-in tabs with
the lock indicator. Close, Delete, and dropping onto Trashcan hide the inbox
and move it to the end of the drawer. Deleting the inbox artifact with
`irudd-scope delete ID` deletes its repository review data.

Configured inboxes refresh current open PRs automatically, including drafts.
Visible inboxes target 30 seconds, inspected PRs 15 seconds, and background
repositories five minutes. These targets lengthen when the complete inventory
cost or GitHub quota requires it. A quiet status line reports the last successful
refresh, the current refresh target, and retry time after a failure. Matching
inboxes share GitHub reads. Launch, selection, wake, and reconnect restore
freshness; suspension and Trashcan stop their work. The desktop must be awake and
Scope must be running. There is no closed PR history.

Sync remains an explicit fallback icon action and joins the same scheduled work.
A failed GitHub read keeps the cached list and retries automatically. Its
tooltip explains the failure; authentication failures name `gh auth login`.
Rate-limit waits apply to manual Sync too.
First load displays the complete PR list before computed GitHub facts finish
loading. Checks, mergeability, and conversation state remain Unknown and the status line explains the
remaining work. Only complete membership reads remove PRs from the list.
Unknown checks or conversation state remain visibly unknown. Any unresolved
GitHub review conversation means the author's turn in the initial app.

Opening a PR captures its ordered review queue and displayed commit. Background
refreshes update the list and local state without moving the person to another PR or changing
the displayed code. Reviews and description in the open pane refresh without
downloading its captured diff again. A newer head offers Load latest commit;
a changed base offers Load latest comparison. Next and Previous
use the captured queue, including after a snooze removes the row from a view.
Opening records inspection; Mark this commit reviewed is explicit and records
the displayed commit. New code can therefore remain in Changed after review.

Notes retain unsaved text through refresh and failed writes. An edit begun
before another client changes the saved note conflicts and offers Use saved
note or Keep my note. Snoozes support presets, a custom date, optional wake on
new commits, and Undo. Undo cannot erase a later snooze from another client.
Pending local edits flush before closing or replacing the HTML; a failed flush
keeps the app open. These local actions never write to GitHub. Open on GitHub
handles public comments, reviews, and merges.

PR inbox links to HTTP(S) destinations open in the system's default browser,
including links from agent-authored HTML and direct `window.open` calls. This
uses the person's existing browser login for private repositories. In-page
anchors stay in the inbox. Ordinary HTML and plan tabs also open HTTP(S) links
and popups in the default browser.

Scope supplies native stack membership and active review approval in the PR
model. Agent-authored inboxes decide how to display or filter them. Stack
readiness depends on all open members being out of draft; approval and CI are
separate facts.

PR inbox HTML can open movable, resizable content windows over the mounted
inbox. The HTML supplies each window's content and opening context, including
which PR and comparison to display. Scope supplies the same SDK, live PR data,
window controls, and a transient message channel between the main view and
all its windows. Each project decides its diff presentation. The starter app
uses an HTML template that displays the raw diff, file metadata and reviews.
It keeps the displayed comparison stable and offers Load latest comparison.
If GitHub changes the head or base during a detail load, Scope refreshes that PR
immediately so the window can offer the current comparison. A failed refresh
keeps the saved PR and asks for Sync.

Windows move by dragging their title or outer frame, leaving window buttons
and document content interactive. They maximize to the available workspace.
The focused frame and resize control accept arrow keys. Escape closes the
focused window after its HTML has an opportunity to handle the key. Closing
returns to a surviving opener or the inbox. Window
position, size, content, and drafts remain temporary; switching tabs preserves
the mounted windows. Failed edit flushes keep the affected windows open.
Replacing the inbox HTML closes its old windows after all their local edits
finish saving. Quitting flushes every window too.

Projects can load PR content when opening a window or preload explicit
candidates in batches. The starter app lets the person select up to twenty
rows and choose Preload selected. It never loads every diff automatically.
Partial failures retain successful loads and identify candidates to retry.
Preloading does not mark a PR inspected or reviewed and does not subscribe it
to continuous detail refreshes.

## Agent retrospectives

Retros start when the operator asks an existing coding agent. Scope shows the
agent-authored HTML report with a scoped interactive SDK. Accept, edit and reject
record review decisions; comments and investigation requests go to the existing
agent through a listener or Copy agent request. They do not run commands or
write destination files. Finishing is a conversational instruction to the agent,
with no Finish button.

Reports start directly with findings. Introductory summaries, setup and sync
status, source inventories, standalone metrics tables, and session lists or
appendices anywhere in the report are omitted. Each finding explains what happened, its effect and the proposed correction; supporting
counts, methods and relevant coverage limits belong in its collapsed Evidence
section. Audit metadata stays in the structured report for agents to read.

Retro tabs start permanent. Completed reports remain available in a history
list and reopen for inspection without starting or resuming a coding session.
Finished reports cannot accept new edits. Explicit removal follows normal tab
retention while audit tracking remains independent.

Retrospective settings automatically list the machine running Scope and its
paired remotes. Machines are added and removed through Remotes settings; there
is no separate source setup. The local machine remains listed without pairing.
Per-machine inclusion and runtime choices remain editable. Settings remember
repository inclusion by canonical fetch origin. First-use history
choices are asked by the agent. Memory suggestions default off. Destination
previews show the exact content, source host and personal or project scope.
Unavailable destinations are omitted. OKF destinations come from Memory
settings: each machine with a synced `personal` bundle is offered while memory
sync is on, and OKF is hidden while it is off. Codex editable instructions are labeled as
instructions. Neither Scope's memory switch nor a retro changes native runtime
memory enablement.

## Personal memory

Memory settings select a local irudd-okf bundle. A folder needs no Git repository
or remote. Scope checks the installed CLI and bundle format before using it.
An older bundle reports Migration needed with an agent request to inspect the
required choices. Selecting a folder never migrates existing memory.
The agent can initialize a new empty folder through `librarian apply`.

Memory enables local reading. Git sync has a separate opt-in switch when a
repository is connected. Existing repository preferences remain compatible.
Settings holds every memory and sync control; conflicts offer an agent request.
Librarian's Machines view shows the same per-machine status read-only. Scope performs
no background memory curation or agent calls. Weekly dreaming reminders start
on, can be disabled in Settings, and retain their due and dismissal dates.
Missed reminders produce one notice while Scope is running. Dismissing schedules
the next week. A reminder never begins dreaming.

## Librarian

Librarian replaces the personal memory wiki and graph in the permanent built-in
tab. Views for Browse, Connections, Stages, Activity and Machines share one
selected memory and each keep their place, filters and scroll position across
restart. Editing and discussion belong to the existing coding session; no view
changes memory.

Browse opens a small page of folders and memories. Search and the Stage, Kind,
Applies to and Tag filters replace that page with results. Filter counts cover
the whole library; combined with search they cover the first 300 search hits and
say so. On a wide window the results stay beside the memory being read; on a
narrow one the reader replaces them and offers Back to results. The reader shows
stage, kind, applicability and review as separate plain details, tags as filter
buttons, references with broken targets explained, backlinks, a back trail, and
the memory's recorded changes on request.

Connections draws explicit links one or two steps from the selected memory with
a capped number of nodes, and lists every connected memory with its relation for
keyboard use. Shared tags are an optional overlay labelled as not a reference.
Stages counts the library by Bronze, Silver and Gold, says a stage is not an
approval, and shows a memory's recorded stage changes when chosen there.

Activity lists recorded changes newest first, including changes synced from
other machines, and says what it cannot attribute. Each change shows who
proposed and decided it, why, its dreaming run and evidence when it came from one
on this desktop, before and after text, and cited source revisions. Recorded
evidence opens read-only, separate from the current accepted memory. Decisions
stay in Dreaming: a pending proposal in the open run offers Open in Dreaming.
Machines shows each machine's observed sync state, last successful sync, tooling,
library registration and conflicts. A machine whose memory or sync switch is off
shows only "Sync is off"; a local-only desktop without a repository still shows
its details. A remote that disconnected keeps this session's last details,
marked as possibly out of date, and a remote without any status is marked
unknown. Machines lists what Scope cannot know and links to Settings.

Dreaming starts when the person asks their existing agent. Scope supplies no
chat, model call, agent launch, or automatic finish. The agent attaches its
session to a run, does routine curation itself, and presents only the changes
that need the person. Routine categories are allowed unless the person narrows
them, so a typical run asks about a few changes rather than every file. Each human decision fills the reading area with its reason,
exact before and after text, and collapsed evidence. Search, library lists and
unrelated controls are absent. Accept proposal and Reject proposal record the
exact displayed revision and source revisions. A changed proposal or evidence
fails visibly and retains the decision. The next undecided proposal then appears.
Allowed automatic decisions retain their agent actor, before and after, reason,
and evidence for later inspection. irudd-okf decides when human review is required.

The person asks their agent to amend a proposal or completed change. Revisions
retain the earlier content and review history. Interrupted runs remain in SQLite.
Restart invalidates the agent connection; only an explicitly requested resume
attaches a fresh session capability. Finishing requires an explicit instruction
in the conversation and no unresolved proposals. A completed overview shows a
small page of change summaries; opening one inspects its full content and actor.
Earlier runs remain available on request.

Old wiki drafts remain read-only and copyable in Recovered draft. Migration keeps
the original tab state beside the recovery text. Hiding Librarian retains its
state and reopening uses the same saved tab. Agent reads return the same current
view, selected content, evidence, decision state and UI revision as the renderer.

## Prompts

Prompts is a permanent built-in tab available at startup, in the drawer, and in
search. First launch opens its empty editor. Adding the tab to an existing
workspace preserves the selected artifact. Closing, Delete, and dropping it on
Trashcan hide it without deleting current text or library items. Its UUID,
hidden state, and adjusted editor divider survive restart. Agent changes never
select or reopen it.

The desktop edits one current text-to-image prompt. Seven fixed fields occupy
two rows of four columns, with Subject using two columns in the first row.
Fields use multiline reading text, and the full-width assembled prompt scrolls
below them. The horizontal divider supports dragging, arrow keys, Shift for
larger steps, and Home to restore the default. Smaller windows scroll the
editor instead of reducing fields to single lines. Appearance and typography
follow Scope settings and shared tokens.

Each field heading opens a full-window picker with field guidance and server
search across item names, fragments, and descriptions. Explicit pagination
keeps library reads bounded. Example images load as they approach the visible
area and illustrate library entries only. The picker displays complete copied
text and descriptions, preserves editor text, and returns focus on close.
Escape closes the picker before exiting fullscreen. CLI agents curate the
library; the desktop has no library editor or generation controls.

Picking an item copies its text into one field. Editing that copy does not
change the library. Its current item title and Edited indicator identify the
copy. Library edits leave field text unchanged. Restore reads the latest
library fragment explicitly. Deleting an item detaches its selection while
retaining copied text. Clear, replacement, Restore, and Reset offer Undo;
Undo detaches deleted item references too. Further text changes, including
updates from an agent, dismiss the previous Undo so it cannot replace newer work.
Reset clears only current choices
and text. Output uses the fixed field order, highlights the corresponding
text on field focus or hover, shows a word count, and offers Copy prompt.
Prompt actions contains library ZIP export through a native save dialog.

Typing saves automatically with revision checks. New typing and the cursor stay
in place while earlier writes finish. A local SQLite recovery draft retains
both the latest local text and any dispatched request awaiting confirmation.
Conflicts keep local text visible and offer Keep my edits, Use saved prompt,
and Copy my text. Keep my edits rereads current revisions and removes vanished
item references before saving. Use saved prompt offers Undo. Failed saves
prevent hiding or quitting through the existing workspace save barrier, with
Keep open available on quit. Reconnection refreshes clean text and library
items; dirty text remains available for recovery.
