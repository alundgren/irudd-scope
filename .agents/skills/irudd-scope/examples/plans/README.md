# Synthetic native plans

These self-contained examples use fictional data and no external resources.
Run against a running, matching-version Scope desktop. From the repository root:

```sh
vp exec node packages/cli/dist/main.mjs plan publish reading-example .agents/skills/irudd-scope/examples/plans/ui/plan.json .agents/skills/irudd-scope/examples/plans/ui/overview.html
vp exec node packages/cli/dist/main.mjs plan next reading-example
vp exec node packages/cli/dist/main.mjs plan item reading-example recover
vp exec node packages/cli/dist/main.mjs plan publish export-example .agents/skills/irudd-scope/examples/plans/non-ui/plan.json .agents/skills/irudd-scope/examples/plans/non-ui/overview.html
vp exec node packages/cli/dist/main.mjs plan item export-example recover
```

For an installed CLI, use `irudd-scope` and absolute paths to these files instead.
Choose unused names when repeating creation. Overview has local check selection
and complete canonical procedures. Work items lists both items in a table; the
second waits on the first. These are proposals with no recorded results.

To try progress, record evidence for `save` and `repeat` with `plan evidence`, then
run `plan done reading-example persist`. The table marks it done and `plan next`
moves to `recover`. Republishing with a changed `repeat` check makes its evidence
stale and the item no longer done.
