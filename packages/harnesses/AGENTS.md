# Harness scanning

This package reads the coding agent harnesses installed for one account and
builds the scan defined in `packages/protocol/src/harnesses.ts`. Desktop main
runs it for its own computer. Keep storage, HTTP and Electron out of it, and
depend only on `@irudd-scope/protocol`.

- Read only each harness's own default folders under home, and the install
  links named in the guide. Never write, move, rename or delete anything.
- Use `lstat` and `readlink`; never follow a symbolic link. Reach every path
  through `belowHome`, which checks that each folder between home and the
  target is a real directory. List a linked skill, agent or instruction file
  by its name and do not read its target. Open files with `O_NOFOLLOW` and
  check the handle is a regular file before reading.
- Copy out only the facts in the contract. Never return or log token values,
  keys, MCP commands, URLs, headers or environment values, or account emails
  and names. Swallow parse errors: JSON and TOML messages quote the input.
- Never read session or chat contents; they only add to folder sizes.
- Take versions from install link targets, or for Cursor from the names of
  its own version folders. Run `--version` only when neither names the version, once, with a short time limit, and stop it when the
  caller's signal aborts: the whole process group on macOS and Linux, only the
  binary on Windows. Never read update caches.
- Validate each scan and keep its JSON within `MAX_HARNESS_SCAN_BYTES` by
  shortening lists and marking them truncated.

Test through the built CLI and the desktop in `../../tests/harnesses-*.test.ts`
with synthetic homes that contain secret markers.
