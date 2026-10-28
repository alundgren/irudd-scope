# Harness scanning

This package reads the coding agent harnesses installed for one account and
builds the scan defined in `packages/protocol/src/harnesses.ts`. Desktop main
runs it for its own computer. Keep storage, HTTP and Electron out of it, and
depend only on `@irudd-scope/protocol`.

- Read only each harness's own default folders under home, and the install
  links named in the guide. Never write, move, rename or delete anything.
- Use `lstat` and `readlink`; never follow a symbolic link. List a linked
  skill or agent by its link name and do not read its target. Open files with
  `O_NOFOLLOW` and check the handle is a regular file before reading.
- Copy out only the facts in the contract. Never return or log token values,
  keys, MCP commands, URLs, headers or environment values, or account emails
  and names. Swallow parse errors: JSON and TOML messages quote the input.
- Never read session or chat contents; they only add to folder sizes.
- Take versions from install link targets. Run `--version` only when no link
  names the version, once, with a short time limit. Never read update caches.

Test through the built CLI and the desktop in `../../tests/harnesses-*.test.ts`
with synthetic homes that contain secret markers.
