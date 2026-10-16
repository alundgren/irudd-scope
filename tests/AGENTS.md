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
`sketchpad.test.ts` and `sketchpad-fullscreen.test.ts` cover the Sketchpad
through Electron. `desktop.test.ts` and
`workspace.test.ts` and `tab-types.test.ts` exercise real Electron through
`desktop-fixture.ts`. `tab-events.test.ts` checks group routing and subscription
cleanup through the tab event API.

Use the fixture for isolated profiles, discovery, and ports. Keep live
provider calls and native Keychain access out of standard tests. Close
processes and stores and remove temporary files even when assertions fail.

Prefer complete user outcomes, then focused integration and unit cases where
they add evidence. Expected values must express an intended contract. Do not
add tests just to preserve current private behavior, prose, or file names.
