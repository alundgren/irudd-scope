# Save reviewed retro lessons with irudd-okf

Use this reference when Scope retro memory is enabled and a finding should
become an irudd-okf concept. Scope stores the preview, the human decision and
the outcome. You prepare, check and write the file with your normal local or
SSH tools. Scope never runs OKF, SSH or file commands. These steps match
irudd-okf v0.1.0; inspect the installed help when the version differs.

Memory stays off by default. A missing CLI or bundle never blocks ordinary
instruction corrections.

## Verify the destination

Run the collector on the actual destination host:

```sh
python3 scripts/retro_sessions.py destinations --source-id SOURCE \
  --okf-store /absolute/bundle/root
python3 scripts/retro_sessions.py destinations --source-id SOURCE \
  --project /absolute/checkout --repository github.com/owner/repo \
  --okf-store /absolute/checkout/.okf --okf-scope project
```

The helper only reports that `irudd-okf` exists and that the root is a
readable directory. Before saving the destination in Scope settings, also check:

```sh
irudd-okf --version
irudd-okf cli schema write
irudd-okf --bundle memory=ROOT context
irudd-okf --bundle memory=ROOT search "a known topic" --scope memory --limit 5
```

Always pass exactly one explicit `--bundle memory=ROOT`, so globally activated
bundles cannot widen a search or receive a write. Do not run `doctor` as a
discovery step; it validates the whole corpus. Exercise `write` and `validate`
only in a private scratch bundle, never in the live destination.

`destination.path` is the canonical absolute bundle root. Personal bundles use
scope `operator` and have no repository. Project bundles use scope `project`,
the repository's canonical origin from Scope's normal origin rules, and a root
inside that physical checkout. Two worktrees of the same repository are
different destinations. The destination's `sourceId` must already be an
included Scope source. Do not create destination-only hosts or treat a Scope
hub address as an SSH alias.

`context` reports an explicit mount as kind `explicit`, even for a folder you
own. The CLI's personal guard looks at its own registration, not Scope's
scope. For an approved `operator` destination, pass `--authorize-personal` on
the write. The flag is not permission by itself; the human decision is. Do not
register or activate bundles to change what the CLI reports.

## Record the host you will write on

Each proposal's `okfEdit.sourceConnection` names the route you used:

- Local: `sshAlias` and `endpoint` are null. Set `hostIdentity` to a stable
  machine identity, such as `/etc/machine-id` on Linux or
  `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice` on macOS.
- SSH: set `sshAlias` to the configured source alias. Take `endpoint`
  (`hostname`, `port`, `principal` as user) from `ssh -G ALIAS`. Set
  `hostIdentity` to the host key fingerprint that SSH verified, for example
  `ssh-keygen -lF "[HOST]:PORT"` (or `HOST` for port 22) against
  `known_hosts`.

Store no SSH config text, key paths, credentials or command strings. If you
cannot establish and later recheck the identity, leave the destination
unavailable. `executionCwd` is the absolute working directory you run the CLI
from on that host. `configurationVersion` is the Scope settings version you
read during preparation.

## Prepare a preview

1. Investigate the real problem behind the finding first.
2. Search the selected bundle for related concepts. Search finds candidates; an
   empty top-five page does not prove that nothing similar exists. Read the
   relevant hits instead of loading the whole corpus.
3. Prefer editing an existing lesson. Otherwise pick a short, stable new path
   and reuse it on retries. `index.md` and `log.md` are not targets.
4. For an existing file, run `read memory PATH` and keep its exact `raw` text
   as `okfEdit.before` and its `hash` (SHA-256 of the raw UTF-8 bytes) as
   `expectedHash`. For a confirmed new file, both are null.
5. Write the complete after-text as `proposal.text`. Keep unknown YAML,
   comments and untouched content. A new concept needs only `type`
   frontmatter. Cite the retro with `sources: - resource: "Scope retro
ARTIFACT_ID, finding FINDING_ID"` and make the lesson readable on its own.
   Leave `verified` absent unless the human actually confirmed the facts.
6. Validate the candidate in a private scratch bundle on the same host:

   ```sh
   SCRATCH=$(mktemp -d)
   irudd-okf --bundle scratch="$SCRATCH" write scratch PATH --file CANDIDATE --expected new
   irudd-okf --bundle scratch="$SCRATCH" validate
   ```

   Exit 3 with errors means the candidate is invalid. Broken links are
   allowed. Remove the scratch bundle afterwards.

Both texts are limited to 16 KiB of UTF-8. Larger concepts need manual review
outside the retro. Do not relabel an OKF write as an instruction correction to
get around this limit or memory being off.

Show uncertainty and contradictions in the finding. Do not silently pick a
winner or encode a priority between personal and project memory.

## What the human can do

Accept records the exact preview. Edit may change only the final text; the
host, root, path and base text stay fixed. For a different destination, path
or base text, publish a new finding and explain that the old one was
superseded. If the old one was accepted, record a `declined` outcome for it.

Scope rejects accepting or editing a preview when memory is off, the
destination changed or was verified again, or the settings version moved on.
Decided previews, including rejected ones, stay in the report as history and
cannot be reused for a new write.

## Write after the human says finish

Accepted edits stay pending until the operator tells you to finish. Then, for
each accepted OKF finding:

1. Read the report again. Use the current decision: its final text, and that it
   is still accept or edit.
2. Read settings again. Memory must be on and the destination must still equal
   the proposal's destination, with the same settings version.
3. Recheck the host: same `ssh -G` endpoint and host key fingerprint, or same
   local machine identity; same working directory, root and, for project
   destinations, the same repository origin. A same-named alias that now points
   at another machine fails this check even if the files are identical.
4. Validate the final text in a scratch bundle again if it changed after your
   preview.
5. Stage the final text in a private file on the destination host, then write:

   ```sh
   irudd-okf --bundle memory=ROOT write memory PATH --file FILE --expected HASH_OR_new
   ```

   Add `--authorize-personal` for an approved `operator` destination. Pass
   arguments as an array; never put correction text into a shell string.

6. Read the path back and check that `raw` and `hash` match the agreed text and
   the write result.

Any changed decision, connection, settings version or base hash stops that
write. It needs a fresh preview and a new acceptance. Capability checks are
temporary; do not update `verifiedAt` or settings during application.

A write already running on another machine can finish after a settings or
decision change. There is no cross-machine transaction. Record what happened,
stop further writes and discuss any reversal.

## Failures and retries

- Exit 4 `CONFLICT`: the file changed or already exists. Read and compare. Do
  not swap in the new hash and overwrite.
- Lost reply: read the path. Identical approved bytes mean the content is
  present; do not claim who wrote it unless the evidence shows that. Different
  bytes need a new preview.
- Follow the CLI's documented recovery for retained locks or recovery paths.
- A saved file whose Scope outcome failed to publish: confirm the file, then
  retry the identical Scope request or read the new version. Do not create a
  second concept.
- A whole-bundle `validate` may report unrelated existing errors. Report them
  separately from the candidate's own result. Never roll back automatically.

Record each result with `retro apply` as an `applied`, `failed` or `declined`
outcome. Evidence names the destination, path, old and new hashes, the CLI
version and any Git step. A failed write stays failed until it is repaired or
the human chooses to finish with it.

## Git and later retrieval

Saving into a repository bundle leaves an ordinary working-tree change. Agents
in that checkout can already read it. Commit, open a pull request or merge only
when the operator asks. For a memory-only pull request use `irudd-okf git
status`, `git preview` with the concept path and fetched base, review the diff,
then `git pr`. Reuse the preview token after a publication failure. Never commit
unrelated changes, force push or merge automatically. `--paths` is
comma-separated, so a concept name containing a comma needs the ordinary Git
workflow. Outcome evidence says which happened: saved locally, committed, PR
opened or PR merged.

A saved lesson is not proof that agents will find it. Offering the OKF skill or
a short `AGENTS.md` pointer to the bundle is a separate change that needs its
own approval. To measure recall, start a fresh session on a matching task and
report whether it found and cited the lesson, the extra tool calls it took and
any mistakes.
