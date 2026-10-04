# Personal memory repository

Scope keeps one personal irudd-okf repository on GitHub in sync on the Mac and
every paired remote. Run `irudd-scope memory guide` for the installed rules and
`irudd-scope memory status` to see each machine. The person turns Memory on in
Scope Settings on the Mac first; `memory connect` is refused until then.

## Create a new repository

1. Find the GitHub account with `gh api user --jq .login`.
2. Suggest `LOGIN/personal-memory`. Wait for the person to accept that exact
   name or give another. Never pick a different name yourself.
3. Run `gh repo view LOGIN/NAME`. If it succeeds, the repository exists. Stop,
   say so, and ask for another name. Never reuse, overwrite, or delete it.
4. Create it only with `gh repo create LOGIN/NAME --private`. Refuse any request
   to create it public or internal; the person can change visibility on GitHub
   themselves.
5. Clone it into a new temporary folder, run `irudd-okf init .` there, commit
   with a short message, and push the default branch.
6. Run `irudd-scope memory connect LOGIN/NAME`. Every machine clones it to
   `~/.local/share/irudd-scope/memory/NAME` and registers it as the irudd-okf
   bundle `personal` within a few minutes. Remove the temporary clone.

## Connect an existing repository

Use this after reinstalling Scope or when the person already has a memory
repository. Confirm the person owns it (`gh repo view OWNER/NAME --json owner`)
and that `index.md` exists at its root
(`gh api repos/OWNER/NAME/contents/index.md`). Visibility is their choice. Then
run `irudd-scope memory connect OWNER/NAME`.

## Write memory

Use the `okf` skill and `irudd-okf write` against the `personal` bundle. Scope
commits and pushes changed files every five minutes; never commit or push in
Scope's synced folder yourself.

Scope shares irudd-okf's writer lock during Git updates. If an OKF write reports
LOCKED while Scope is syncing, retry after that sync. Runtime locks, recovery
copies, and temporary files stay on their originating machine.

## Resolve sync conflicts

The Mac shows a banner when a machine pushed a `memory-conflict/HOST-TIME`
branch and opened a pull request. For each pull request:

1. Clone the repository into a new temporary folder. Never resolve conflicts in
   `~/.local/share/irudd-scope/memory/NAME`; Scope stops syncing a machine whose
   folder is not on the default branch.
2. `gh pr checkout NUMBER`, merge the default branch, and resolve each file so
   both machines' lessons survive. Show the person the result when the right
   choice is unclear.
3. Push, then merge the pull request with `gh pr merge NUMBER --merge
--delete-branch` after the person agrees. Scope never merges it.
4. Remove the temporary clone. The banner clears on the Mac's next sync.

If status reports an unfinished rebase in Scope's clone, preserve any newer
edits outside the clone before running `git rebase --abort`, restore the saved
edits, then use Sync now. Inspect an unknown `.irudd-okf/write.lock` before
removing it; never remove a lock whose writer is still running.
