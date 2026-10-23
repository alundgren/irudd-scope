# Tests and fixtures

Read [development](../docs/development.md#validation-and-tests) before running
or adding tests. Use `vite-plus/test`, real entry points, and synthetic data.

`vp run test` and `vp run ready` run the standard suite. The separate
`vp run test:remote-updates` suite runs only after direct changes to remote
update logic. Follow the root rule for this trigger. Do not run it for
unrelated changes or add it to `ready`.

`artifacts.test.ts` covers CLI publication, discovery, the HTTP API, and hub
forwarding. `artifact-storage.test.ts` covers the artifact database. `lifecycle.test.ts`
checks tab ownership, publication races, cache convergence, and process crashes.
`maintenance.test.ts` checks scheduling, interruption, and disk reclamation.
`desktop-storage.test.ts` and `credentials.test.ts` cover preferences, drafts,
and credential failures.
`sketchpad.test.ts` covers the Sketchpad through Electron. `desktop.test.ts` and
`workspace.test.ts` and `tab-types.test.ts` exercise real Electron through
`desktop-fixture.ts`. `tab-events.test.ts` checks group routing and subscription
cleanup through the tab event API.

Use the fixture for isolated profiles, discovery, and ports. Keep live
provider calls and native Keychain access out of standard tests. Close
processes and stores and remove temporary files even when assertions fail.

Follow the [test rules](../docs/development.md#validation-and-tests) that
`vp run check` enforces:

- Name the promises each test protects from `promises.ts` in its `tags`
  option. If none fits, do not add the test. Propose promise changes to the
  repository owner in the pull request description instead of editing the list.
- Reach Scope only through the built CLI, the HTTP APIs, the Electron UI, and
  `@irudd-scope/protocol`. Never import from `apps/` or `packages/`.
- Keep the suite within `maxTests` in `test-limits.ts`. Delete a weaker test to
  add one. Never raise the limit or add a `frontDoorExceptions` entry.
- When a test breaks on a change that keeps behavior the same, delete it.
  Update a test only when promised behavior changed on purpose.

Expected values must express an intended contract. Do not add tests just to
preserve current private behavior, prose, or file names.
