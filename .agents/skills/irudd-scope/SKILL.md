---
name: irudd-scope
description: Publish or update files and text in the Scope desktop library with its CLI when a task asks you to make an artifact available for inspection.
---

# Use Scope CLI

Use the installed `irudd-scope` command when available. For repeated calls from this checkout, use `./packages/cli/dist/main.mjs`. If it is missing, run `vp run build` from `packages/cli` once. Use `vp run scope ...` for a one-off source invocation during development. When you need syntax help, pass `--help` to the same entry point you chose.

## Publish and update

Use `add FILE --id ID` or `text TEXT --id ID` to create an artifact under an ID that can be reused. Without `--id`, the CLI generates a random ID. `add` creates the artifact, so an existing ID conflicts. Use `update ID FILE` for later versions of the same artifact. Updates read the current revision before writing and may return a conflict if another writer changes it at the same time.

For example, with the built entry point:

```sh
./packages/cli/dist/main.mjs add report.md --title "Weekly report" --id weekly-report
./packages/cli/dist/main.mjs update weekly-report report-v2.md
```

Use `text TEXT` for plain text, or `text TEXT --kind markdown` for Markdown. Text defaults to plain text. `--kind` is only for the `text` command.

Publication commands print a JSON artifact record with its ID and revision. Treat that as the receipt; run `list` or `get ID` only when you need to locate or inspect a record. `get` returns metadata, not artifact bytes.

## Choose input the desktop can display

`add` accepts files up to 32 MiB and selects a kind from the file extension:

| File                                              | Scope view        |
| ------------------------------------------------- | ----------------- |
| `.txt`                                            | Plain text        |
| `.md`, `.markdown`                                | Markdown          |
| `.html`, `.htm`                                   | HTML preview      |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif` | Image preview     |
| `.excalidraw`                                     | Editable diagram  |
| Any other extension                               | Downloadable file |

For Markdown, raw HTML is omitted and links and image descriptions appear as text. HTML previews allow inline styles and embedded data images; scripts and external resources are blocked. Use static HTML that works within those limits.

An `.excalidraw` file must contain a finished, valid Excalidraw document. The CLI publishes the provided file; it does not generate or render a diagram from a prompt. It classifies the file by extension but does not validate its contents. The desktop opens it in the diagram view; malformed content may show a load error and remain available to download.

## Connection and confirmation

With no explicit endpoint or token override, the CLI reads `SCOPE_CONNECTION_FILE` or `~/.config/irudd-scope/desktop.json`. Scope must be open on an awake Mac to accept publication. An explicit endpoint from `--endpoint` or `SCOPE_ENDPOINT` requires explicit credentials from `--token-file`, `SCOPE_TOKEN_FILE`, or `SCOPE_TOKEN`; the CLI never borrows the token from local discovery. Keep token values private.

A successful command confirms that Scope accepted the artifact record. It does not confirm that the desktop opened a tab or rendered the content. When the task requires a visual check, inspect the artifact in Scope.

CLI requests share a 10-second deadline. Use `--timeout-ms 60000` when a large remote upload needs more time. A timeout can leave a completed write without a receipt; keep the artifact ID for recovery.

Requests are not queued or replayed. If Scope is unavailable, open it and retry once. After a failed response that may have followed a write, run `get ID` before retrying; inspect the content in Scope when the record's revision alone cannot resolve whether it changed. On a 409 conflict, check the current record and decide whether replacing it again still matches the requested change. Do not repeat an update automatically.
