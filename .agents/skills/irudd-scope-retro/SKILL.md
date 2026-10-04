---
name: irudd-scope-retro
description: Investigate historical Codex and Claude Code sessions for efficiency, correctness, speed and improvements to the coding environment; publish findings in Scope with optional approved corrections or memory proposals.
---

# Scope retro

Use this when the operator starts a coding session and asks for a Scope retro.
The agent investigates; Scope owns settings, reviewed-session tracking and the
interactive report. Do not start agents, install source services or archive transcripts
as part of this workflow.

Read the installed CLI's `irudd-scope retro guide` and the public
[Scope retro workflow](../irudd-scope/references/retros.md) for report publication,
HTML SDK, feedback and explicit finish. Read [native collection](references/collection.md)
when discovering sessions or inspecting historical evidence. This skill includes
its own Python 3 standard-library helper; no other retrospective skill is required.
If `retro guide` is unavailable, upgrade the Scope desktop, CLI, paired hubs and
skills together before proceeding.

## Choose the evidence

Read Scope settings for the automatically listed desktop machine and paired
remotes. Do not ask the operator to add sources. Use source `location` to identify
each host, then resolve access with the agent's existing tools. The desktop is
the machine running Scope, which may differ from the agent's machine. A remote
with null `sshAlias` is still remote; its HTTPS endpoint is not an SSH alias.
Record machines without confirmed access as unavailable. Exhaust Scope tracking
pages and native metadata inventory pages before selecting history. Exclude the
confirmed current native session, saved retro-agent identities, audited whole
session IDs, child sessions and sessions without a reliable Git-origin identity.
Ask about new repositories, then save their include/exclude choices in Scope.

For uninitialized sources, ask whether to start from now, check count and oldest
start first, review all history, or review sessions started after an agreed date.
Resolve relative dates to an explicit UTC cutoff with the operator. Stage that choice
without advancing tracking. For `from-date`, set `initializationCutoff` separately
from the original `discoveredAt` and filter metadata before reading snapshots.
Unknown creation time cannot qualify for a staged or saved date cutoff. Recommend
postponing when a selected source cannot be inspected; record an explicit operator
override if they continue. Unavailable sources keep their existing tracking.

Take snapshots only of explicitly selected historical IDs. Native logs stay on
the source host. An unsupported, changing, incomplete or unavailable snapshot is
failed, not reviewed. The helper's complete flag covers supported records in the
selected file; it does not prove related child histories or native records omitted
by the runtime are available. Inspect linked child evidence separately when useful
and report the coverage. Ask before expanding beyond the agreed audit or diving
into additional sensitive details.

## Explain patterns and corrections

Read and follow [session analysis](references/analysis.md) before analyzing history.
Assess efficiency, correctness, speed and the coding environment for every selected
readable session, then investigate patterns across repositories and time. Automated
screening and short excerpts identify candidates; they do not complete a review.
Mark a session reviewed only after examining its chronological evidence and
recording the required assessment. A complete collector result is a prerequisite,
not the assessment itself. Keep unfinished analysis unreviewed.

Publish ranked findings with causes, effects, concrete evidence, recurrence and
proposed prevention. Include useful practices and project/tooling improvements,
not just user complaints or instruction changes. Explain categories with no
supported findings and gaps that prevented assessment. Missing measurements stay
unknown. A small number of findings needs an adequate investigation, not a quota.

Consider both agent changes and clearer operator direction. General corrections
are available with memory off. Memory is one optional destination for a finding,
never the purpose or completion criterion of the retro. When memory is enabled,
discover capabilities on the actual destination host. Use Claude's runtime-confirmed memory directory,
editable Codex instructions, or the `okf-personal-*` destinations Scope lists
while its memory sync is on (the synced irudd-okf `personal` bundle per machine).
Do not enable native memory or write Codex's generated memory database. For every
proposal, preview exact text, operator/project scope and destination. Ask when a
pattern belongs to a project or the operator's personal guidance.

Publish a freely authored interactive retro tab and connect feedback using the
Scope guide. Treat acceptance as a recorded decision: apply only settled approved
text and destinations, respecting edits and requests for investigation. Make
agreed commits last. Finish only when the operator says to finish in conversation;
there is no finish button. Resolve pending requests, record application outcomes
and finish with the latest report version. Only successful finish advances reviewed
IDs and staged initialization. Completed history is inspectable and read-only;
interrupted retros have no resume protocol.
