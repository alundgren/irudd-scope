# Planning together

The HTML plan stays beside its source editor. Source editing supports arbitrary
HTML without converting the document into a separate editor format. The preview
runs authored scripts. Comment anchors add identifiers to the original source
when an element can be matched safely. Script-created elements and ambiguous
identifiers produce detached comments.

The web controls use Scope's light appearance palette and system typography.
This package owns its copy of those token values because the exploration does
not depend on Electron renderer files. Authored HTML keeps its own styles.
Narrow screens stack source, preview, and discussion in that order.

Save status distinguishes a write in progress, a durable browser draft waiting
for the server, and accepted server content. Overlapping edits preserve local
HTML and show both versions for a deliberate merge or server replacement.
Storage failures keep the visible HTML and offer export and retry.

Version history is read-only. Returning to the live plan restores the current
local draft. Comments stay visible when their element disappears and reconnect
when its unique identifier returns. Presence and preview cursors are temporary.

Rejected changes separates a definitive server refusal from an uncertain reply.
It preserves the original command and reason across reloads, with export,
dismissal, source recovery and edited comment retry. Other editors can continue.
Rejected HTML remains parked until a person edits it; remote changes alone do
not retry it.

The top bar offers exactly three fake users: Alex, Blair and Casey. Selection
belongs to the tab and survives reload. Separate tabs can use the same user
without sharing editor drafts or presence sessions. Switching affects future
commands and presence while queued commands keep their captured author.
