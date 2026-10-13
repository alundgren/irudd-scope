# Memory library

Start with `irudd-scope librarian guide` and `irudd-scope librarian read`.
The guide contains the current validated schema. Use `librarian apply FILE.json`
for mutations. Scope owns the projected view and dreaming run; irudd-okf owns
all file semantics. Read the displayed text before referring to it in conversation.

## Local setup

Agree on a bundle location. Use action `local` with the absolute `root` and
`initialize: false` for an existing current-format bundle. For a new empty folder,
`initialize: true` runs CLI init. Git and remotes are optional. Connection never
migrates existing memory. If Scope reports Migration needed, run irudd-okf's
migration guide for that explicit folder and ask the person about its required
choices. Preserve existing content and follow the CLI's migration recovery rules.

## Dreaming

Begin only after the person asks their existing coding agent. Read the current
UI revision, then send action `start` with the exact user request, existing
session ID and only automatic categories the person explicitly allowed. Save
the returned run ID and temporary capability for this connection.

Read and reason in the existing conversation. Submit a `propose` command or
`present` an existing immutable change with human or automatic disposition,
reason and evidence. Automatic disposition requires a matching permission from
start. irudd-okf can require human review regardless of the requested disposition.
Scope displays one human decision at a time. Its renderer records acceptance or
rejection against the displayed proposal and source revisions. The agent endpoint
cannot record a human decision or pretend an agent decision was human.

Use a new revision to amend a pending proposal. Earlier revisions remain
inspectable and become superseded. Undo a completed change as a fresh proposal;
never silently erase its history. Keep actor, reasons, before/after and evidence
for permitted automated work. `librarian read` returns the actual current
presentation, selected raw text, evidence, decision state and UI revision.

Use stable request IDs and identical payloads when retrying uncertain work.
Read and reconcile revision conflicts. Restart interrupts durable queues and
invalidates all capabilities. Resume only when the person explicitly asks, with
their exact request and a fresh existing-session attachment. Finish only after
a separate explicit conversational instruction and no unresolved proposals.
Completed overviews are for optional inspection, never automatic continuation.
Scope has no memory chat, model call, background curation or agent launcher.

## Optional Git sync

Enable Memory in Settings, then explicitly connect the approved `OWNER/NAME`
with `irudd-scope memory connect OWNER/NAME`. For a new repository, obtain the
person's approval of the exact repository first. Create it private with `gh`,
initialize a current-format bundle and publish it before connecting.

Git sync is a separate Settings switch. Each machine uses its own gh login.
Portable OKF manifests and history sync with notes; runtime locks and journals
remain local. Conflicts become `memory-conflict/*` pull requests. Resolve them
in isolated clones and never in the running Scope clone. Scope never merges them.
