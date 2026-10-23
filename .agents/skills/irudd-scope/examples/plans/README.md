# Synthetic native plans

These self-contained examples use fictional data and no external resources.
Run against a running, matching-version Scope desktop. From the repository root:

```sh
vp exec node packages/cli/dist/main.mjs plan publish reading-example .agents/skills/irudd-scope/examples/plans/ui/plan.json .agents/skills/irudd-scope/examples/plans/ui/overview.html
vp exec node packages/cli/dist/main.mjs plan item reading-example recover
vp exec node packages/cli/dist/main.mjs plan publish export-example .agents/skills/irudd-scope/examples/plans/non-ui/plan.json .agents/skills/irudd-scope/examples/plans/non-ui/overview.html
vp exec node packages/cli/dist/main.mjs plan item export-example recover
```

For an installed CLI, use `irudd-scope` and absolute paths to these files instead.
Choose unused names when repeating creation. Overview has local check selection
and complete canonical procedures. Work items shows the selected outcome and its
owned checks separately from its prerequisite. These are proposals, with no
recorded agreement or verification results.

To try retained evidence, capture a basis from a current read, add an actual
agreement or observed result using `plan guide`, then publish a revision with a
changed criterion and visual. The recorded proposal remains available in Work
items and the selected packet. Keep those records in subsequent publications.
