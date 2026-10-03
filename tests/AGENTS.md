# Tests and fixtures

Read [development](../docs/development.md#validation-and-tests) before running
or adding tests. Use `vite-plus/test`, real entry points, and synthetic data.

`vp run test` and `vp run ready` run the standard suite. The separate
`vp run test:diagram` suite runs only when diagram plugin implementation
changes; `vp run test:remote-updates` runs only after direct changes to remote
update logic. Follow the root rules for these triggers. Do not run either
suite for unrelated changes or add them to `ready`.

`artifacts.test.ts` covers CLI publication, discovery, the HTTP API, and hub
forwarding. `artifact-storage.test.ts` covers the artifact database. `lifecycle.test.ts`
checks tab ownership, publication races, cache convergence, and process crashes.
`maintenance.test.ts` checks scheduling, interruption, and disk reclamation.
`desktop-storage.test.ts` and `credentials.test.ts` cover preferences, drafts,
and credential failures.
`diagram.test.ts` covers provider responses; `diagram-desktop.test.ts` covers
diagram generation and editing through Electron. `desktop.test.ts` and
`workspace.test.ts` and `tab-types.test.ts` exercise real Electron through
`desktop-fixture.ts`. `tab-events.test.ts` checks group routing and subscription
cleanup through the tab event API.

Use the fixture for isolated profiles, discovery, and ports. Keep live
provider calls and native Keychain access out of standard tests. Close
processes and stores and remove temporary files even when assertions fail.

Prefer complete user outcomes, then focused integration and unit cases where
they add evidence. Expected values must express an intended contract. Do not
add tests just to preserve current private behavior, prose, or file names.
