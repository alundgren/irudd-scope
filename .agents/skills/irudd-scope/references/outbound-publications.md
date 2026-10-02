# Publish Scope HTML with a coding agent

Scope keeps the source HTML and publication checkpoints. The current coding
session uses its signed-in provider tools to publish. Scope does not start a
session, sign in to a provider, or run a background sync.

Use the CLI entry point selected in `SKILL.md`:

```sh
irudd-scope publications guide
irudd-scope publications read ARTIFACT_ID
```

The guide prints the installed command schema. Use exact returned artifact IDs,
tab UUIDs, operation UUIDs, and remote version markers. All commands except
`guide` require the desktop online, directly or through its paired hub.

## Check the runtime and the HTML

Claude Code's native Artifact tool requires a subscription session signed in
with `/login`. An API key session cannot publish. The tool must actually be
available in the current session. OpenAI Sites requires Sites tools in the
current host. A Codex terminal session does not automatically have them.
When a tool is missing, explain that limitation and stop before preparation.
Never copy OAuth credentials or call private provider endpoints.

Publish ordinary HTML or the HTML of a Scope plan. Scope review annotations,
comments, and history stay in Scope. PR inbox apps depend on Scope's injected
SDK and cannot be published through this workflow. Check other pages for
Scope-only APIs and local resources before proceeding.

Use a complete self-contained document. Adjacent files are not exported. Claude
artifacts have a 16 MiB rendered limit and restrict external resources and
network calls. Inline styles, scripts, and data images are the safest input.
Sites can host static HTML. This workflow exports one immutable HTML document,
not an arbitrary application or its backend. If adapting the page is necessary,
update the Scope artifact first. Never edit a prepared export and claim its
original revision was published.

## Verify the destination audience

Both providers can share content publicly. A saved link or ownership result
alone never proves the current audience.

A new native Claude artifact starts private to its creator. Existing Claude
artifacts require an authenticated inspection of the Share dialog using an
available browser tool. Confirm that public sharing is off and every viewer
and editor belongs to the same organization, or that only the owner has access.
Artifact `list` can supply `updatedAt`, but it cannot establish the audience.
Without authenticated audience inspection, report "Cannot verify current
audience" and block the update. Do not suggest making the artifact public to
read its metadata.

For Sites, call `get_site` and inspect its access policy. This release supports
owner-only Sites, using `deploy_private_site_version` or
`save_version_and_deploy_private`. These tools enforce owner-only access before
deployment. Shared, public, externally invited, and unverifiable destinations
are blocked. Never fall back to general deployment when private deployment
fails. Workspace administrators can have access under the provider's policy.
Do not change sharing settings as part of publication.

Check the signed-in account and workspace identity every time. A different
account or workspace requires stopping and explaining the mismatch. Scope
stores metadata supplied by the agent. It does not independently query providers
or continuously monitor access.

## Check remote edits before publishing

Read the Scope checkpoint and obtain fresh remote facts immediately before
preparation. For Claude, obtain the matching artifact's update date and native
version when available. A truncated list that omits the artifact is unknown,
not evidence that it was deleted or unchanged. Keep Claude's native version
guard. A provider 409 stops the operation. Never reread and use `force` as an
automatic retry.

For Sites, inspect saved versions and any known deployment. A saved version
can differ from the deployed version. `list_site_versions` supplies each
version's latest publish attempt, which is not proof of the current production
deployment. Preserve exact version IDs, source commit IDs, and deployment IDs.
If the runtime cannot establish the active deployment, set both observation
marker fields to null and warn that current change metadata is unknown. Sites deployment tools have
no conditional content version parameter. Every existing Sites update therefore
requires acknowledgement that publishing can replace a concurrent remote edit.
Recheck immediately before deployment, and stop if those facts changed.

A changed version, a later remote edit date, or missing comparable metadata
must produce a warning before the provider write. Inspect the destination link
in Scope before acknowledgement. Ask the person to acknowledge
replacement through Scope's publication dialog. Approval covers the observed
operation, not a different destination or new remote edit. The authorize
command includes `expectedObservation` from the displayed operation. Its
semantic fields must still match, while `checkedAt` may be refreshed. After
approval, refresh the same operation with fresh facts before start. Changed
facts invalidate the acknowledgement. Public or unknown
privacy cannot be overridden by accepting an overwrite warning.

## Use the native provider workflow

### Claude

Use the native Artifact tool's list operation to locate an existing artifact
and its `updatedAt`. Read or attach the exact existing URL before preparation
so the native tool retains its current base version. Set `conditionalWrite`
true only when that guard is actually retained for this destination. Otherwise
set it false and acknowledge the concurrent replacement warning. Do not reset
the native base after Scope's last remote check without rechecking in Scope.

After Scope permits start, publish the exact exported HTML with the native
Artifact tool. Supply the saved URL for updates. For new publications, omit
it. Record the returned artifact ID and URL immediately. Preserve the native
version or provider update date for completion when available. A confirmed
publish may have unknown change metadata; record null markers and warn on the
next update. If the response or its success is uncertain, reconcile instead
of completing or repeating the publish.

### Sites

Use the host's supported Sites source and packaging workflow. Keep its working
project outside the Scope repository. Copy the operation's exact exported HTML
to the configured static directory as `index.html`. Do not transform its bytes.
Prepare local source before requesting provider publication.

Read `.openai/hosting.json` first. Reuse its exact `project_id` and Scope's saved
project identity. For a new project, call `create_site` once after the Scope
operation is started. Immediately save the returned ID atomically in the
manifest and record it with Scope progress. A missing source credential needs
`create_source_repository_write_credential` for that same project, not another
creation. Before saving content, use `get_site` to verify current owner-private
access. New project creation itself is not a successful HTML publication.

Use the short-lived returned source credential only for Git authentication.
Never persist its token in the manifest or Scope. Commit and push the exact
HTML, hosting manifest and static configuration to the returned source branch.
The commit SHA must match that branch's current HEAD. Package build output or
configured static assets from that same commit into a tar archive containing
`.openai/hosting.json` and `index.html` inside the directory declared by
`static.directory`. Keep source, commit and archive unchanged until save
succeeds. Use the host's Sites skill when available to obtain the exact static
manifest configuration; if the runtime cannot package it, stop and retain the
operation rather than guessing deployment fields.

Call `save_site_version` with the exact project ID, pushed commit SHA and
absolute archive path. Record the returned saved version and source commit
with Scope progress. Recheck the owner-private audience and remote facts,
then call `deploy_private_site_version` for that saved version. Record its
returned deployment ID before polling `get_deployment_status` for the same
project and deployment. Complete only when it reports `succeeded` for the
exact saved version and provides the production URL. Do not infer success
from save or creation.

When the active production deployment is verifiable, encode its marker version
with exactly `JSON.stringify({savedVersion, deploymentId})`, in that key order,
using the provider's opaque IDs. Use the same format at observation and
completion. Do not manufacture an active deployment from the newest saved
version's latest attempt. Use null observation markers when that fact is
unavailable. A confirmed successful deployment result may supply the known
saved-version/deployment pair at completion.

## Keep recovery possible

Prepare and export the immutable operation's HTML. Mark the operation started
before the first provider mutation. Save a returned destination ID immediately,
before the next provider write. For Sites, also retain the exact saved version,
source commit, and deployment ID as soon as each is known. Keep provider tokens
in the agent's temporary credential handling, never in Scope commands, HTML,
logs, or source control.

A failed response can follow a successful remote write. Read the unresolved
operation and reconcile that exact destination before proceeding. Never create
a second destination or repeat an uncertain publish automatically. Preparation
freshness may expire, but Scope retains the operation for recovery. An existing
operation blocks another publication to that provider.

For Claude, record completion only after a confirmed successful native publish.
For Sites, wait for the deployment's terminal successful result matching the
project and saved version. A saved version, expected URL, or pending deployment
is insufficient. Retry a lost Scope completion acknowledgement with the exact
same operation and result. A later local HTML revision remains unpublished.

Cancellation and unlinking leave remote content intact. After a started
operation, reconcile the provider result before deciding to cancel. Unlink
removes Scope's saved destination and checkpoint. It does not revoke provider
sharing or delete the remote artifact.

## Provider references

- [Claude Code artifacts](https://code.claude.com/docs/en/artifacts)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
