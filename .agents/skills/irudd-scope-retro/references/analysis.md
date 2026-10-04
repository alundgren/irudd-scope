# Session analysis

A retro should explain how the work went and what would improve future work.
Discovery, accounting, report controls and memory approval do not establish that
the sessions were analyzed. This procedure adapts the investigations in the
[irudd-skills session retrospective](https://github.com/alundgren/irudd-skills/blob/main/resources/skills/session-retrospective/SKILL.md)
and [Matt Pocock's retro](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md)
to historical, multi-repository work. It is self-contained; those skills are not
runtime dependencies.

## 1. Assess each selected session

Use the explicit whole-session snapshot and its coverage notes. Read the supported
conversation and relevant tool activity in chronological order. For large output,
work through bounded batches on the source host and carry forward compact notes
with native session IDs and record locations. Preserve changes of plan, intermediate
failures, reviewer feedback, recovery and outcomes. Keep native logs on their host.
Filter credentials and unrelated sensitive content before displaying evidence.

Automated summaries, keyword matches and ranked calls help locate evidence. Verify
them against the original records. First/last messages, the last few corrections,
or a few slow calls alone are screening, not a session review. Do not discard the
middle of a session or treat a successful ending as proof of an efficient process.

Record a compact assessment for each session: task and outcome, efficiency,
correctness, speed, environment candidates, useful practices, evidence locations
and unavailable evidence. For each area distinguish a supported observation,
no supported finding after assessment, and inability to assess. Keep these working
notes outside product commits and publish their coverage, not transcripts.

Only a complete snapshot with this assessment can become `reviewed`. A readable
session still being screened stays `eligible`; a failed snapshot stays `failed`.
Reviewing an unfinished task is possible: report its observed ending without
claiming the task or implementation succeeded. Resolve incomplete analysis before
proposing finish; never advance audited IDs merely because collection succeeded.

## 2. Investigate these areas

### Efficiency

Separate primary-session activity from explicitly attributable related activity.
Assess repeated or unnecessarily broad reads, duplicate exploration, oversized
successful tool outputs, avoidable retries and unproductive communication. Identify
the largest output-volume and context-pressure opportunities using attributable
commands and recorded sizes where available. Distinguish necessary diagnosis and
verification from avoidable work; volume alone is not a defect.

Report available uncached input, cache reads/writes and output separately from
cumulative totals and current/peak context. Never convert a cache-inclusive total
into billed cost. The collection helper exposes only native token totals, native
call counts and matched call/result intervals; it does not supply all the richer
accounting above. Inspect supported native evidence where needed, document the
method, and leave unavailable fields unknown. Parse recognizable wrapped calls
before attributing activity to tools; report unparsed coverage. A wrapper containing
several commands is a batch, not evidence for assigning all bytes or time to one.

When scouting occurred, assess the question, answer, follow-ups, repeated owner
exploration and later feedback from available primary evidence. Explain ownership
and delivery uncertainty. Keep child sessions excluded according to the agreed
selection; do not launch replay agents. Without attributable source reads and
responses, scout context savings and independent quality remain unavailable.

### Correctness

Trace mistakes, rework, reviewer findings, validation gaps and changes in operator
direction through the session. Distinguish an agent error from changed requirements,
ambiguous instructions, repository conventions and missing information. Check how
the problem was discovered and whether the recorded fix addressed it. Also identify
successful verification or recovery worth preserving.

Do not infer test failure from an error word in a search result or document. Inspect
the actual command and result. Conversation claims about an implementation are
not independent code verification. For important candidates, check retained code,
tests or configuration at the historical revision when available. If only today's
checkout is available, label that check as current-state evidence.

### Speed

Investigate slow tools, sequential work that could safely overlap, repeated
expensive commands, validation reruns and mismatches between intended focused
tests and actual execution. Establish command scope and why each run happened.
Required final validation and necessary failure diagnosis are confidence work.

Use recorded command durations where available. Matched call/result intervals
include scheduling and transport; overlapping intervals cannot be summed into wall
time. Separate intrinsic tool/test slowness from avoidable workflow delay. Preserve
unknown timings rather than constructing a ranking from missing values.

### Coding environment

Assess these opportunities even when memory is off:

- Navigation: difficult file discovery, missing pointers and missed callers or
  dependencies. Check whether existing guidance was absent, unclear or overlooked.
- Automated checks: errors a deterministic lint, type, test or CI check could
  prevent. Inspect existing scripts and CI first; a broken or unused check is a
  different problem from a missing one. Follow repository rules for validation.
- Review standards: repeated judgement errors, unclear reviewer criteria or rules
  better enforced mechanically. Prefer a deterministic check for a mechanical
  failure and review guidance for decisions that require judgement.
- Instructions and skills: contradictions, excessive always-loaded instructions,
  ineffective rules and missing task procedures. Verify which guidance applied at
  the time; do not prescribe another rule for an existing rule that was ignored.
- Tool economy: noisy CLI/MCP output, wrong tool choice, repeated boilerplate or
  missing focused commands. Explain the supported effect on context or latency.
- Information access: unavailable logs, service state or other evidence that caused
  guessing or retries. Recommend the necessary access without inspecting additional
  sensitive systems or expanding the audit without approval.

## 3. Compare patterns and verify candidates

Keep assessments across all selected repositories, machines, runtimes and the
agreed time window. Group related observations and inspect recurrence, severity
and impact. Support recurrence with distinct native IDs and a denominator from
the sessions actually assessed. Separate one serious incident from a repeated
pattern. Include earlier and middle portions of the window, successful sessions
and recovery; recent explicit complaints must not determine the whole report.

Investigate the strongest candidates against original conversations and commands,
then inspect the relevant existing guidance, scripts or code before prescribing a
change. Check counterexamples and existing fixes. Small or uneven runtime samples,
excluded child activity and failed large/unsupported snapshots limit comparisons;
report those limits rather than treating missing work as successful or efficient.

## 4. Publish useful actions

Lead with the most consequential findings. Explain efficiency, correctness, speed
and environment findings in the freely authored report; use Scope's existing
finding categories. Show differences between repositories or periods only when
the evidence supports them. Aggregate totals are context for an investigation,
not a substitute for explaining causes and improvements.

For each finding provide evidence locations and session IDs, observed effect,
likely cause, recurrence/coverage, confidence and a specific next action. Distinguish
facts from inference. Route the action to the appropriate place: a project fix,
tooling or validation improvement, navigation/documentation change, reviewer rule,
skill procedure, operator clarification or optional personal memory. Existing
fixes and useful practices can be findings without a new change.

When prevention warrants development work, include a self-contained issue draft:
title, problem and evidence, proposed scope and acceptance criteria. Otherwise
explain why no follow-up is warranted. Do not create issues or apply changes without
authorization. Exact instruction/memory proposals still need the verified scope,
destination and preview required by the main workflow.

## 5. Check analysis coverage before finish

The report must distinguish discovered, excluded, collected, assessed and failed
sessions. Show assessment coverage by repository, source/runtime and time period,
plus which areas could not be assessed and why. A collector's `complete` flag is
not analytical coverage, and a disclaimer does not make shallow screening enough.

Before presenting the analysis as complete, verify that every `reviewed` session
has the assessment from step 1, all areas above were investigated, important
candidates were checked against primary evidence, and actions are not limited to
memory by default. Explain areas with no supported findings. Findings have no
minimum count; do not invent recommendations to fill categories. If these criteria
are unmet, state that the retro is still incomplete and continue analysis. Follow
the separate explicit-finish and approval procedure only after this check.
