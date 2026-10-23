---
name: irudd-scope
description: Create native structured plans, retrospectives, and GitHub PR inbox apps in Scope, and set up the personal memory repository Scope syncs. Also publish or update artifacts, show the agent's working folder as a Folder tab when the person asks, and generate narration with the desktop OpenRouter key. Honor an explicitly requested planning tool or output format.
---

# Use Scope CLI

Use the installed `irudd-scope` command when available. For repeated calls from this checkout, use `vp exec node packages/cli/dist/main.mjs`. If it is missing, run `vp run build` from `packages/cli` once. Use `vp run scope ...` for a one-off source invocation during development. When you need syntax help, pass `--help` to the same entry point you chose.

The CLI supports native Windows PowerShell and Command Prompt. In PowerShell,
put multiline examples on one line or use PowerShell continuations, not Bash
backslashes. Write payload files as UTF-8 and pass their paths as separate
arguments. Use `$env:SCOPE_CONNECTION_FILE` for an override; do not print the
discovery file or its token.

## Publish and update

Use `add FILE --id ID` or `text TEXT --id ID` to create an artifact under an ID that can be reused. Without `--id`, the CLI generates a random ID. `add` creates the artifact, so an existing ID conflicts. Use `update ID_OR_NAME FILE` for later versions of the same artifact. Updates read the current revision while connected, or use the paired hub's saved revision offline. They reject concurrent changes, including changes found when a queued update delivers.

For example, with the built entry point:

```sh
vp exec node packages/cli/dist/main.mjs add report.md --title "Weekly report" --id weekly-report
vp exec node packages/cli/dist/main.mjs update weekly-report report-v2.md
```

Use `text TEXT` for plain text, or `text TEXT --kind markdown` for Markdown. Text defaults to plain text. `--kind` is only for the `text` command.

Direct publication commands print a JSON artifact record with its ID and revision. Paired hubs return a queue receipt with `id`, `queued: true`, and `expiresAt`, including while the desktop is connected. Treat the returned JSON as the receipt; run `list` or `get ID` only when you need to locate or inspect a record. `get` returns metadata, not artifact bytes.

## Receive a tab sharing link

When the person asks you to import a Scope tab sharing link into their receiver,
run it through that receiver's normal Scope connection:

```sh
irudd-scope import-link 'scope-transfer://v2/#...'
```

The command authorizes import without a desktop receive click. Main uses the
receiver's saved pairing key, authenticates and inspects the source, validates
the content, and commits an independent local copy. It returns JSON containing
`artifact` and `alreadyImported`. Use that receipt to report the imported title
and ID. Sharing-link creation and Scope-to-Scope pairing stay in the desktop app.
Both computers must be awake and online with Tailcat installed separately. The agent
may use a connected paired hub; import requests are never queued. The command
defaults to a 300,000 ms timeout. If a result is uncertain, retry the same link;
an existing copy is returned without duplication. Opening a link alone does not
authorize import. Expired invitations require a new link from the source app.

## Choose input the desktop can display

`add` accepts files up to 32 MiB and selects a kind from the file extension:

| File                                              | Scope view        |
| ------------------------------------------------- | ----------------- |
| `.txt`                                            | Plain text        |
| `.md`, `.markdown`                                | Markdown          |
| `.html`, `.htm`                                   | HTML preview      |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif` | Image preview     |
| Any other extension                               | Downloadable file |

HTML previews run interactive prototypes and mockups, including scripts, external styles, fonts, images, network requests, forms, and popups. Publish a complete document with embedded resources or reachable URLs. Adjacent files are not uploaded; use absolute resource URLs or set the document's base URL. Normal browser rules such as CORS apply. For Markdown, raw HTML is omitted and links and image descriptions appear as text.

### Prompt library and current prompt

Use `irudd-scope prompts guide` for the installed command schema. `prompts
structures` describes the seven predefined fields; `prompts read` returns the
one current workspace and assembled text; `prompts list` and `prompts item UUID`
read the initially empty library. Use `prompts apply REQUEST.json` to curate
items, set current parts or reset the workspace. Every mutation needs a UUID
requestId and expectedRevision. Give each new item a new UUID; deleted item IDs
cannot be reused. Retry uncertain delivery with exactly the same
request and body. On 409, read again and reconsider changes before using a new
request ID. Continue library pages through apply using the returned cursor and
unchanged filters; restart if the library revision changes.

Library edits keep copied current text. Deletion detaches selection while
preserving text. Do not replace a human's current work without their task's
authorization. Commands never change the selected desktop tab. There is no
model generation, saved-prompt history or import. Optional per-item
exampleScene contains separately authored title and prompt metadata.

`prompts image REQUEST.json IMAGE_FILE` reads an explicit PNG, JPEG or WebP.
The request uses set-image, id, requestId and expectedRevision, omitting image.
Images retain their bytes in SQLite and are limited to 8 MiB and 4096 pixels per
dimension. Remove an image through apply with image=null.
`prompts export --output NEW_FILE.zip` exports the library and referenced images
with a versioned manifest, excluding the current workspace and other Scope
content. It refuses overwrite and exports above 128 MiB. These operations need
the desktop awake and connected; paired hubs never queue them offline.

### Pull request inbox apps

When asked to create or customize a PR inbox, read
[PR inbox authoring](references/pull-requests.md). It covers creation through
the CLI, the complete PR data model, HTML SDK methods, agent command payloads,
and conflict recovery. Create the named HTML app from the current agent session;
the desktop's Create PR inbox button is optional.

Scope supplies `window.scope.pullRequests` and persists repository, GitHub,
local, and agent data separately from HTML. Use `update NAME inbox.html` to
change an existing app while keeping that data. Scope runs the desktop user's
`gh` for reads; inbox operations never mutate GitHub. Use
`pull-requests guide` for the installed CLI's exact validated command schema.

### Agent retrospectives

When asked to do a Scope retro, read [retro workflow and authoring](references/retros.md).
Start in the existing coding session; Scope never launches an agent. Use
`retro guide` for the installed command schemas and the public
`irudd-scope-retro` skill bundled in this repository for local or SSH histories. Publish a named HTML report
with `add report.html --retro --name RETRO_NAME`, then connect `retro watch`
to this session before reporting that feedback is connected.

The HTML SDK records decisions, notes and investigation requests. Acceptance
does not write files. Apply approved corrections and agreed commits last,
then finish only after the person's conversational instruction. Finished
reports remain available in history; audited whole native session IDs prevent
repeat selection. Memory suggestions default off and verified optional
destinations never change the runtime's native memory settings.

### Memory library

When asked to set up, dream over, connect, or fix the person's Scope memory,
read [memory library](references/memory.md). Start with
`irudd-scope librarian guide` for the validated command schema. Local bundles
require no Git or remote. Keep conversation in the person's existing agent
session. Scope presents one human decision at a time and never launches an
agent or finishes automatically.

### Native plans

For feature planning, read [native plans](references/plans.md). Publish an authored
visual overview with structured goals, checks and independently usable work items.
Honor an explicitly requested planning tool or format. A planning request does not
authorize implementation. Keep discussion in chat and record only actual agreement.

Use `plan guide`, `plan publish NAME PLAN.json OVERVIEW.html`, `plan read NAME`,
`plan item NAME ITEM_ID`, `plan content NAME --output FILE.html`, and
`plan capture-basis NAME BASIS_ID --expected-revision REVISION`.
Replacements require `--expected-revision`. Preserve retained proposal bases and
records. Generic `update` rejects structured plans; legacy `add --plan` creates
ordinary HTML. A new native plan starts permanent, so closing hides it by default.

## Show your working folder

Open a Folder tab only when the person asks to see your folder or files in
Scope. Pass a short `--title` naming the task:

```bash
irudd-scope folder open . --title "Login fix"
```

The JSON receipt has `tabId`, `machine` (`local` or the remote's ID), the
canonical `path`, and `created`. Each folder has one tab per machine. Running
the command again returns the same tab with `created: false`, renames it when
`--title` changes, and brings it back from Trashcan or the drawer. Scope never
switches the person's selected tab; the Folder tab appears unread at the end of
the strip and selects itself only when no tab is open. On a paired remote the
command goes through the hub and fails with `Scope desktop is not connected`
when the desktop is away; it is never queued. `Update Scope on HOST to share
folders` means that machine's Scope or hub predates folder tabs. Scope reads
files only inside the folder and stores no copy of them.

To point the person at a file, such as "select the plan file you just made",
pick the file they mean, usually the one you just wrote, and run one command.
FILE is relative to the folder:

```bash
irudd-scope folder select . docs/plans/login.html --title "Login fix"
```

It opens the tab first when there is none (`created: true`), expands the
folders down to the file, and selects it. Scope still does not switch tabs; the
Folder tab is marked unread. A FILE outside the folder or missing fails and
changes nothing.

`irudd-scope folder find .` prints `open: true` and the `tabId` when the folder
has a tab in the strip, and `open: false` (exit 0) when it has none or the tab is
closed or in Trashcan. `irudd-scope folder watch .` keeps running and prints one
JSON line per event; it prints `{"type":"closed"}` and exits 0 when the person
closes the tab, and fails when the folder has no open tab or Scope disconnects.

## Connection and confirmation

With no explicit endpoint or token override, the CLI reads `SCOPE_CONNECTION_FILE`, defaulting to `%LOCALAPPDATA%\irudd-scope\desktop.json` on Windows or `~/.config/irudd-scope/desktop.json` on macOS and Linux. Scope must be open on an awake computer for direct publication. A paired hub always stores CLI publications before attempting delivery, regardless of desktop connection state. An explicit endpoint from `--endpoint` or `SCOPE_ENDPOINT` requires explicit credentials from `--token-file`, `SCOPE_TOKEN_FILE`, or `SCOPE_TOKEN`; the CLI never borrows the token from local discovery. Keep token values private.

A publication command returning an Artifact confirms that Scope persisted a tab and its artifact record. A receipt with `queued: true` and `expiresAt` confirms only that the paired hub stored the publication for background delivery while the desktop is connected. Report that pending state accurately. The queue holds at most 50 tabs, expires 48 hours after reservation, and survives hub restarts. Transient delivery failures back off from 3 seconds to 5 minutes. Scope sends a one-time wake signal when the desktop resumes, resetting the cooldown for enabled remotes. Manually disconnected remotes stay off. Use `hub queue` to inspect pending entries and `hub discard ID` to cancel one when asked. It does not confirm that the desktop opened a tab or rendered the content. New publications appear in tabs, selecting the first arrival in an empty workspace and preserving the current selection otherwise. Tabs beyond the visible strip remain available in its searchable overflow dropdown. When the task requires a visual check, inspect the artifact in Scope. Closing a tab moves it to Trashcan and retains its content and draft for seven days. Temporary tabs also enter Trashcan after a day outside the visible strip; the user can keep them permanently with the bookmark control. Quitting or restarting Scope preserves tabs left open.

Publication commands share a 10-second deadline. Use `--timeout-ms 60000` when a large remote upload needs more time. A timeout can leave a completed write without a receipt; keep the artifact ID for recovery.

Paired hubs buffer every `add`, `text`, and `update` publication automatically, including while the desktop is connected. An offline update needs metadata previously read or published through that hub while connected. The hub retains up to 1,000 recent artifact records for 48 hours after observation, including IDs, names, titles, and revisions. If no saved revision exists, read the tab through the hub once while connected. Updates preserve its saved name and title unless a title is supplied. A changed desktop revision blocks delivery and remains visible in `hub queue`; never discard and replace it automatically. Direct publishing and speech require Scope to be connected. A full queue rejects new publications, and delivery conflicts remain visible in `hub queue` until discarded or expired. After a failed response that may have followed a write, inspect `hub queue` and run `get ID` when the desktop is connected before retrying; inspect the content in Scope when the record's revision alone cannot resolve whether it changed. On a 409 conflict, check the current record and decide whether replacing it again still matches the requested change. Do not repeat an update automatically.

## Delete and reclaim space

When asked to remove an artifact, use `delete ID`. This deletes its content,
tabs, and drafts on the desktop, including through a paired hub. The JSON
receipt contains `id` and `deleted`; an absent artifact returns `deleted: false`
with success. This explicit command bypasses Trashcan; ordinary desktop close
retains the tab for seven days. Reads and lists include retained trash, but
updates fail until the user restores the tab in Scope.

Use `shrink --timeout-ms 120000` for both desktop databases through the normal
artifact connection. Use `hub shrink --timeout-ms 120000` for the local hub's
own database; it works with the desktop disconnected. Read per-database statuses
in the JSON receipt. Deferred or failed work exits nonzero. Unused uploads can
remain protected for fifteen minutes, and receipts report those bytes.

After a caller timeout, inspect `shrink --status` or `hub shrink --status`
before retrying maintenance. Upgrade the desktop, CLI, and hub together for
the tab-first publication protocol. The CLI performs the required tab creation
before uploading content or metadata.

## Generate speech for agent-owned playback

Use `irudd-scope voice guide` for the machine-readable agent guide and
`irudd-scope voice --help` for syntax. Save a unique request ID before submitting:

```sh
irudd-scope voice generate narration.txt --request-id unique-narration-id \
  --output narration.wav --receipt narration.json
```

Scope uses the desktop's shared OpenRouter key and Gemini 3.8 Flash TTS.
New requests default to Aoede with restrained conversational delivery (selected
style C), including when instructions are blank. For two speakers (selected
style E), Aoede leads and Leda replies. Use the instructions returned by
`voice guide` and read [podcast delivery](references/podcast.md) for script writing,
turn generation, and the WAV joining helper. Explicit `--voice` and
`--instructions` override the defaults; do not replace these preferences with
a generic announcer, commercial, or documentary delivery unless requested.
The person must enable Voice generation in Settings first. Supply verbatim
narration and separate delivery instructions; Scope sends those instructions
through Google's speech metadata options. Agents own scripts, HTML, timing,
playback, and explicit audio/receipt exports.

After a timeout or lost response, inspect `voice status ID` and retrieve
`voice result ID --output recovered.wav --receipt narration.json`. Reusing the
same ID and payload never resubmits during its 24-hour lifetime; different payloads
conflict. Never automatically switch to a new ID after an uncertain outcome.
The CLI prints a generated ID before contacting Scope if `--request-id` is omitted.

Audio can finish before billing. `voice status ID --refresh-billing` starts an
actual OpenRouter lookup; inspect status later and refresh the receipt file.
Unknown cost is null, never an estimate or zero. Downloads and billing lookups
never regenerate. `voice cancel ID` stops local work without promising a refund.
A five-minute desktop deadline ends unfinished generation. Completed results
survive restart; unfinished requests become interrupted without retry.

Scope must run on an awake computer. Narration is limited to 16 KiB UTF-8 and style
instructions to 2048 characters. There are two active generation slots and no
retained request count limit. Requests, receipts, and results expire after 24 hours from
submission. Audio transfers are bounded to 16 MiB. Export to a new `.wav` path;
receipt files can be refreshed in place. After expiry an old ID may trigger a
new paid request, so inspect uncertain outcomes within that lifetime.
