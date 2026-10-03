# Semantic history experiment

This experiment runs beside the web app. It never opens the app database or changes the HTML API. Run its synthetic comparison with:

```sh
vp exec node apps/plan-web/experiments/semantic-history/demo.ts /tmp/plan-web-semantic-comparison.json
vp test run --project=standard tests/plan-web-semantic.test.ts --maxWorkers=1
```

The comparison creates temporary SQLite databases, compares the existing `PlanStore` with this operation store, and deletes the databases after saving results. `PLAN_WEB_SEMANTIC_LENGTHS=100,1000` controls synthetic history lengths, with a maximum of 5,000 changes. Measurements include retained JSON bytes, closed SQLite file bytes, median write time, checkpoint reads and full replay. They describe one machine and one document, not production capacity.

## What the experiment stores

Every accepted change has an immutable ID, actor, short reason, declared parent revision, server ordering, reducer version and receipt. The store validates an operation against its declared parent before reconciling with the current branch. Retrying an identical ID returns the original receipt after the branch advances. Reusing it for different content fails. SQLite transactions persist changes and branch pointers before returning a receipt.

Branches are rows pointing to existing revisions. Merges retain both parent revisions and references to incoming changes. Checkpoints store materialized HTML, provenance and conflict decisions. Replaying an earlier reducer version remains explicit; an unknown version fails rather than silently interpreting old operations differently.

Supported operations replace the text of an authored block, insert HTML after an authored element, delete an element, resolve a competing text choice, restore an earlier revision and merge branches. An operation targets a unique authored HTML ID and includes the expected previous text or exact element bytes where applicable. Missing targets, duplicate IDs and unexpected prior values reject an invalid proposal at its parent. If a valid target was changed or removed concurrently, the accepted change records an explicit conflict without discarding the proposal.

HTML remains canonical. The reducer uses parser source locations to replace only the targeted bytes. It never serializes the parsed DOM. Scripts, styles, comments, whitespace, custom elements and unrelated entity spelling survive unchanged. Text replacement deliberately excludes raw-text elements and blocks containing child markup. Authored IDs are required for operation targets; the experiment never inserts IDs into a document automatically.

## What the comparison demonstrates

Two agents replace the same PostgreSQL decision with SQLite and DynamoDB. A third adds independent deployment context. Every arrival order keeps the independent section and both recorded choices. One choice is materialized and the other becomes an unresolved conflict containing its operation and competing change IDs. A resolution appends another change; it does not remove the alternatives or their reasons.

The existing app already uses SQLite events and receipts as its authoritative history. Git generates its displayed HTML diffs. This experiment compares operation history with complete HTML changes and snapshots, not with a Git repository used as the database.

Block operations reduce repeated HTML storage and provide explicit intent and logical branches. They also reject some useful combinations. Two agents changing different words in the same paragraph produce a block conflict, while the existing text merger can retain both. Same-anchor insertions use server acceptance order, with the latest insertion immediately after the anchor. They are deterministic for a recorded history but do not commute across arrival orders.

## Limits

This is a narrow single-process experiment, not an HTTP service. It has no browser integration, production migrations, agent authentication, move operation, text-range operation, grouped changes or reconciliation agent. Only text-choice conflicts support direct resolution. Structural conflicts remain recorded for inspection. Merge reads current branch heads in its transaction; there is no API to require previously reviewed heads. Full replay uses recursive ancestry and parses HTML repeatedly, so long histories need further performance work before adoption.

Restoring a revision appends a change containing the selected revision reference. It restores that revision's HTML and conflict state while preserving every later accepted history entry. It does not selectively undo one actor's changes.

## Research and recommendation

Zed's [DeltaDB introduction](https://zed.dev/blog/introducing-deltadb) describes fine-grained addressable deltas and conversation history between Git commits. Its [public beta announcement](https://zed.dev/blog/delta-public-beta) describes shared worktrees, messages and review. These support retaining operations and intent. They do not establish that an HTML AST or this conflict reducer is the correct representation for a planner.

The structured document proposal supplied for this exploration adds stable node IDs, first-class conflicts, branch pointers and checkpoints. The useful next step is an optional stable-ID operation API with bounded intent alongside the existing full-HTML API. Preserve arbitrary authored HTML and measure real agent requests before choosing finer text operations. A wholesale conversion to a JSON tree would need an explicit compatibility decision for scripts, styles and arbitrary markup.
