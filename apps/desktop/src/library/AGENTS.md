# Published content library

Main owns HTTP publication, discovery, `scope.db`, and library refreshes.
Public artifact contracts stay in `packages/protocol`; preserve their names,
HTTP routes, and on-disk data locations when reorganizing desktop code.

`store.ts` stores metadata and immutable bytes in SQLite. Validate content
before publication and keep revision checks with the metadata transaction.
`library.ts` refreshes published metadata and caches content by revision.

`use-library.ts` and `content-view.tsx` are renderer helpers for subscriptions,
unread state, and content loading. `tab-state.ts` defines the shared reference
to a published item. These files must not import main-process code or plugin
implementations. Keep file and diagram rendering in their plugin directories.

Validate storage imports against existing data and test HTTP publication and
reconnection through the protocol client. Use synthetic content and temporary
profiles in tests.
