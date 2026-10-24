# Native plans

A plan pairs an authored visual overview with structured goals, checks and work
items. Scope stores the proposal, actual agreement and verification evidence.
Conversation and agent execution stay in the coding session.

## Check feasibility before presenting and building

While drafting the first proposal, send a scout to do a quick technical
feasibility check against the current code. Give it the proposed outcome and
the main technical assumptions. Ask it to find the relevant implementation,
existing limits and anything that could prevent the proposal from working.
Keep this bounded to feasibility, without implementing the feature. The scout
reports what it finds; the drafting agent checks the findings and decides how
to address them before showing or publishing the first proposal to the person.

After the person agrees on the plan, prepare the work item breakdown and send
it to an independent technical reviewer before implementation starts. Give the
reviewer the agreed proposal, the work items and the earlier scout findings.
The reviewer must use its own scout to inspect the code and check that the
items can be built together. Check dependencies, shared contracts, integration
ownership and whether the completion checks can run through real entry points.
The reviewer makes the assessment; its scout helps with code lookups.

Fix problems within the agreed plan and have the reviewer recheck the affected
items. If a fix would change an agreed outcome, constraint or acceptance
criterion, pause affected work and return to the person. Explain the problem,
its practical consequence and the smallest proposed change in plain words.
Discuss and revise together until the person agrees, then review the revised
breakdown before starting that work. Never weaken the agreed plan just to pass
review, or treat reviewer approval as the person's agreement.

Keep technical lookup details in agent context and item context or constraints.
The person's presentation stays in plain words, without file names, line
numbers or review reports. These checks add no required plan fields or views.

Use the coding session's delegation tools and follow its scout and reviewer
launch rules. When available, use `model-settings` for model selection and
launches. If delegation is unavailable, report the missing check instead of
silently skipping it. Scope stores the plan; it does not launch these agents.

## Explain the outcome

Start with an ordinary concrete scenario. Use a sequence for communication, a
flow for branches, a state diagram for a lifecycle, a chart for quantities, or a
product mockup for an interface. State what a mockup commits to once. Distinguish
walkthrough controls from proposed product controls. Early proposals may omit
checks and work items while consequential choices are still open.

Author dark neutral HTML with clear text contrast and purposeful state colors.
Give each whole scenario a distinct background region and enough space to see
its beginning and end. Keep its visual and checks together. Avoid faint rules as
the only section boundary, repeated badges, decorative borders and boxes around
every sentence. Native Scope controls follow the person's appearance setting;
the authored document keeps its colors.

Remove captions that repeat the picture. Keep assumptions that change its
meaning. Use realistic synthetic values and identify illustrative measurements.
After showing the presentation, ask the next consequential question in chat.
Do not repeat the presentation or add an approval questionnaire to the page.

## Make checks inspectable

Each check has a short label plus a complete expectation, conditions and method.
Classify it as agent or human judgment. Agree on measurements and conditions
before treating an ambiguous word such as "fast" as a criterion.

Apply visual explanation throughout the checks. Show starting conditions, action
and observable result together. Use a before/after view, timeline, comparison or
annotated mockup when it explains more clearly than prose. A selected check may
use the full width. Keep the relevant visual visible and consequential conditions
near the example. Plain text is enough for a simple result.

Keep the complete canonical procedure accessible through a
`data-plan-procedure="CHECK_ID"` element. Scope fills it with a folded Test
procedure containing expectation, conditions, method and judgment kind. Authored
scripts can read `window.scopePlan.data` before they run. A `data-plan-goal` element
receives the goal outcome; `data-plan-check` receives the expectation.
`data-plan-checks="VISUAL_ID"` provides a simple ordered check list when custom
visual verification is unnecessary. Use IDs internally and descriptive human labels.
Visual anchors must be literal quoted HTML IDs in the authored source.

Inspect the rendered desktop at laptop and narrow widths. Every check must remain
reachable and complete. Do not shorten a criterion to fit a diagram. Remove
repetition or divide focused views when overloaded. Discuss a smaller outcome or
an uncertainty-resolving prototype if the whole proposal remains hard to follow.

## Publish, read and revise

Use `irudd-scope plan guide` for the field guide and limits. Write a JSON object
with `version: 1`, `title`, optional context/constraints/questions, and records.
The publish command inserts the supplied HTML as `overviewHtml`.

```sh
irudd-scope plan publish feature-plan plan.json overview.html
irudd-scope plan read feature-plan
irudd-scope plan item feature-plan ITEM_ID
irudd-scope plan content feature-plan --output overview-copy.html
irudd-scope plan publish feature-plan revised.json revised.html --expected-revision 1
```

Read before editing. Preserve all bases, agreements and evidence in the next JSON.
A replacement requires the exact revision read; never fetch a newer revision just
to force an old proposal through. Generic `update` refuses structured plans.
`plan content` exports the exact authored HTML and refuses to overwrite a file.

Two runnable synthetic examples are in [examples/plans](../examples/plans/README.md).
They cover an interface and a command-line export. Adapt the example to the actual
relationship rather than treating its layout as mandatory.

## Record actual agreement and evidence

Capture the current discussed proposal without implying approval:

```sh
irudd-scope plan capture-basis feature-plan discussed --expected-revision 1
irudd-scope plan read feature-plan
```

Capture publishes a new artifact revision. Add an agreement with a new `id`, the
`basisId`, relevant `targetIds` and the actual `note`. Evidence has its own ID,
basis ID, check ID, expected and observed behavior, implementation, actual
conditions, result and optional references. Publish using the new read revision.
Do not infer agreement from publication or evidence from an agent assertion.

A basis retains the exact proposal, including original HTML and checks. Records
resolve against that basis even after current checks change or disappear. Existing
basis IDs and records cannot be redefined. To correct a record deliberately,
remove it, append its ID to `removedRecordIds`, and add a correction under a new
ID. Preserve previous removal IDs and all bases. Ordinary revisions cannot silently
drop history. The complete document must fit 32 MiB; oversize fails without pruning.

Recorded evidence does not automatically verify a changed proposal. Assess whether
it still applies and record the tested implementation and conditions accurately.
If a valid check exposes a bug, fix the implementation. If the required outcome
changes or a check cannot be performed, discuss it and pause affected dependent
work. Do not weaken a criterion or report partial verification as complete.

## Give a fresh agent one item

Each item has one coherent outcome, context, goals, owned checks, dependency item
IDs and constraints. Split by independently assessable outcomes, not PR size or
implementation layers. Assign integration checks to an explicit owning item.

`plan item` supplies owned completion checks separately from prerequisite checks
and recorded evidence. Related checks sharing a goal are context, not additional
completion requirements. It includes applicable goals, constraints, questions,
visuals, exact retained proposals and instructions for retrieving the full plan.
Work-only checks must have an owner and cannot be placed beside a visual.

Reads and basis capture need an online desktop. Same-version paired hubs can queue
publications with explicit revisions; a queue receipt is not desktop delivery.
Older installed hubs reject JSON plans until updated separately. Use the new CLI
with a direct isolated desktop for a first local trial. Legacy `add --plan` HTML
creates ordinary HTML tabs and cannot overwrite a structured plan.
