# Publication commands

The CLI owns file detection, inexpensive optional provenance, local discovery,
and explicit publication. Use the shared protocol client and contracts. Do
not import app internals or move storage into the CLI.

An explicit endpoint must never receive the discovered local token implicitly.
Unknown provenance stays absent and must not block publication. Keep JSON
output and useful failure exit codes. Public flags and command names are
compatibility contracts.

Validate through the built executable in `../../tests/artifacts.test.ts`.
Include command failures and local discovery when affected. The executable's
Node shebang is required at runtime; development commands use Vite+.
