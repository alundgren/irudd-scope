# Tests and fixtures

Read [development](../docs/development.md#validation-and-tests) before running
or adding tests. Use `vite-plus/test`, real entry points, and synthetic data.

`artifacts.test.ts` covers CLI publication, discovery, the HTTP API, and hub
forwarding. `storage.test.ts` covers the artifact database. `settings.test.ts`
and `credentials.test.ts` cover preferences, drafts, and credential failures.
`diagram.test.ts` covers provider responses. `desktop.test.ts` and
`workspace.test.ts` exercise real Electron through `desktop-fixture.ts`.

Use the fixture for isolated profiles, discovery, and ports. Keep live
provider calls and native Keychain access out of standard tests. Close
processes and stores and remove temporary files even when assertions fail.

Prefer complete user outcomes, then focused integration and unit cases where
they add evidence. Expected values must express an intended contract. Do not
add tests just to preserve current private behavior, prose, or file names.
