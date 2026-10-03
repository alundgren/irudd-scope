# Reading plans together

The browser is for reading accepted HTML and discussing it. Agents edit through
the API. The HTML uses nearly all the viewport, with a compact row for the plan
name, fake user, presence, comment selection and the comments toggle. Opening
comments reserves a side panel; closing it returns that width to the HTML.
Narrow screens use a dismissible panel over the preview so the document remains
readable. History, exports, rejected comments and legacy HTML archive access
live under More because they are secondary to reading and commenting.

The web controls use Scope's light appearance palette and system typography.
This package owns those token values because the exploration does not depend
on Electron renderer files. These cool tokens intentionally take precedence
over the house palette. Authored HTML keeps its own styles and runs its scripts.

Comment selection reuses a unique authored element ID. Missing or duplicate IDs
and generated elements produce detached comments. The browser never inserts
IDs into canonical HTML, including canceled selections. Comments remain visible
when their element disappears and reconnect when its unique authored ID returns.

The composer clears only after browser comment persistence succeeds. Offline
and uncertain delivery keep the original queued command and its captured actor.
Permanent refusals stay in Rejected comments with an editable retry, export and
dismissal. A refusal or old HTML conflict does not block other comments.

Version history is read-only. Return to live plan displays the latest accepted
HTML. Old HTML drafts and request records stay in a read-only export archive.
Pending legacy requests retain an explicitly unknown original outcome. They
never send automatically. An agent can recover exported work deliberately.
There are no source, save, merge or restore controls in the reader.

The top row offers exactly three fake users: Alex, Blair and Casey. Selection
belongs to the tab and survives reload. Separate tabs can use the same user
without sharing presence sessions. Switching affects future commands and
presence while queued commands keep their captured author.
