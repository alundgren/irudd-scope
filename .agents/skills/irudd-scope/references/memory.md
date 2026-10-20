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
UI revision, then send action `start` with the exact user request and existing
session ID. Omit `automaticPermissions` to allow the routine categories listed
in the guide. Pass a narrower list only when the person names one, or `[]` when
they want to decide every change. Save the returned run ID and temporary
capability for this connection.

Read and reason in the existing conversation. Install and follow the
okf-librarian workflow (`irudd-okf skill install DIRECTORY --name okf-librarian`).
Pick a bounded batch. Do routine work yourself: consolidate repeated episodes,
merge duplicates, add evidence, promote stage, archive stale memories and repair
links. Submit each as a `propose` command with disposition `automatic`, its
routine category as `permission`, a reason and evidence. Present judgment calls
with disposition `human`. Category names are labels; irudd-okf decides which
changes need a human, and Scope presents those for a human decision regardless
of the requested disposition. Scope displays one human decision at a time. Its
renderer records acceptance or rejection against the displayed proposal and
source revisions. The agent endpoint cannot record a human decision or pretend
an agent decision was human. When the batch is done, tell the person what you
completed, what waits for them and what remains for the next run.

Proposals left pending by an older run keep their recorded review requirement.
Propose the same bytes again to get a fresh assessment. Outside edits,
migrations and the person's own proposals stay with them: irudd-okf refuses
agent proposals for those files, so `present` the pending change with
disposition `human`. An interrupted run keeps
its permissions; pass `automaticPermissions` on `resume` only when the person
changes them.

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
