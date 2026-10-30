# Agent session reading

This package reads one computer's T3 Code history and the Claude Code and Codex
logs behind it, and returns facts for the Agent sessions tab: threads, their
messages, token counts, list-price cost and tool calls. It stores nothing.
Keep storage, HTTP and Electron out of it.

- Never write, move or delete anything. Open `statev2.sqlite` read-only and
  only read the harness log files.
- Run the reader in its own process (`reader-process.ts`); SQLite reads are
  synchronous and T3's database can be several gigabytes.
- Hide secret-looking text in every input, output and message before it leaves
  the reader process. Keep tool output as its size and its first and last
  2 KB.
- Report facts only. `groups.ts` sorts tool calls by program and failure cause
  with rules read from their text; every rule set keeps an "other" bucket that
  the tab shows.
- T3's tables are another program's private layout. Treat each row as
  untrusted: skip rows that do not parse, and fail the whole read with a fixed
  message when a table or column is missing.

Test through the desktop in `../../tests/sessions-local.test.ts` with a
synthetic T3 database and logs that contain secret markers.
