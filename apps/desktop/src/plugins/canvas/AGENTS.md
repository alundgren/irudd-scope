# Canvas plugin

A canvas tab is a board of cards. Each card has a type, such as `boxes`, a
frame on the board and its own content. The board changes only frames, titles
and stacking order; a card's editor changes only that card's content.

- Main is the only writer. Views send changes as `put`, `set` and `del` ops
  with the version they read; `library/canvas-store.ts` applies them in one
  transaction, records the undo step and answers retries from the request
  receipt. Never write canvas rows anywhere else.
- Board and card content are maps from ID to record, never lists. Order uses
  fractional keys from `order.ts`. Main makes every ID; a change names new
  records with `$` names.
- Undo is per person or agent and per scope (the board, or one card). An undo
  leaves alone fields someone changed after the undone step. Camera and the
  open card are tab state, not history.
- A card type lives in `cards/<type>/`. Its `contract.ts` holds the record
  rules and limits without React or Electron, so main and views share it.
  Never rename a stored card type.
- The tab type is `canvas`. Never use `diagram`: startup deletes old diagram
  tabs. Canvases start permanent.

Test through real Electron with synthetic canvases, through the board UI and
`window.scope` canvas operations.
