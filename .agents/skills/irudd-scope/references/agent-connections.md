# Agent connections

`irudd-scope diagram watch NAME` holds one event connection to Scope, including
through a paired hub. With a host destination, it wakes the agent for human
messages and proposal acceptance or rejection. Canvas edits wait until the next
request; rebase then to read the current canvas. Creating a proposal does not
wake the agent that submitted it. Add `--watch-edits` only when the person wants
live canvas feedback. Without a host destination, stdout includes all notices.

Agent writes do not echo back as human edits. Notices coalesce for 800 ms;
ignored canvas edits do not delay a queued message. On reconnect the listener
checks the current version. Messages are transient and have no replay guarantee.
Scope chat retains the conversation in its tab.
If the editor is busy or still loading, the listener waits for its version
without starting an agent turn. It reports `Listening to NAME` once that check
succeeds. Stop the process to cancel the wait.
Startup also waits through temporary Scope or T3 connection failures.
Authentication failures, missing diagrams, and invalid host responses stop with
an error. A reconnect during a pending version read schedules another read, so
edit observers can recover the current version after a disconnect.

Stop the listener when the task ends. It also stops when the named tab is deleted
or its working directory disappears. Run it from the worktree. Listeners store
no global model or event cache. Use one destination per listener. The listener
holds no model turn open. Do not keep a tool call waiting or poll it in an agent
loop. Start it under the session host or a service manager that survives tool
cleanup; shell backgrounding and `nohup` alone may not survive that cleanup.

## T3 Code

Use T3's normal `t3 pair` flow to obtain a scoped bearer, stored in a private
token file. The required scopes are `orchestration:read` and
`orchestration:operate`. Keep credentials out of command arguments and logs.
Take the T3 thread ID from the active thread URL, and verify the thread's
worktree before connecting; the provider's Codex thread ID is different.

```sh
irudd-scope diagram watch NAME --t3-thread THREAD_ID \
  --t3-token-file /private/token-file
```

The default address uses `T3CODE_HOST` and `T3CODE_PORT`, falling back to
`http://127.0.0.1:3773`. `--t3-endpoint` overrides both. HTTP is allowed on
loopback or a numeric IP assigned to this machine, including its Tailscale IP;
another machine requires HTTPS. Use T3's actual listening address. A loopback
proxy is unnecessary when T3 is bound to another interface on this machine.

On Linux with a systemd user service manager, this keeps the listener alive
after the launching tool call returns. Supply absolute paths and an explicit
T3 address because the service manager does not inherit the tool's environment:

```sh
systemd-run --user --collect --unit=scope-diagram-NAME \
  --working-directory="$PWD" \
  --setenv=SCOPE_CONNECTION_FILE=/absolute/path/to/desktop.json \
  /absolute/path/to/irudd-scope diagram watch NAME --t3-thread THREAD_ID \
  --t3-endpoint http://T3_ADDRESS:3773 --t3-token-file /private/token-file
journalctl --user -u scope-diagram-NAME -n 10 --no-pager
```

Verify `Listening to NAME` in the log before reporting a connection. When the
task ends, run `systemctl --user stop scope-diagram-NAME`. Do not enable automatic
restart after a host delivery error: inspect the thread before reconnecting so
an uncertain request is not repeated. On other hosts, use their managed process
facility with the same lifetime and cleanup rules.

T3 receives a user follow-up through its authenticated orchestration API.
Delivery while busy follows T3's queue behavior. Its command ID remains the
same for an ambiguous retry. Revoke temporary sessions with T3's auth CLI when
testing is done. T3's API can change independently of Scope.

## Codex App Server

The session host must expose a reachable App Server WebSocket and an existing
thread. Connecting to an unrelated App Server does not wake a terminal session
owned by another process. Use the host's thread ID and endpoint:

```sh
irudd-scope diagram watch NAME --codex-thread THREAD_ID --codex-url ws://127.0.0.1:4500
```

Scope starts a turn when idle and steers the active turn using its expected
turn ID. A failed or uncertain delivery stops the listener and reports an
error; inspect the thread before restarting. A standalone Codex terminal has
no universal external wake-up endpoint. Use T3's adapter for T3 sessions.

## Claude Code channels

Register a local stdio MCP server in the project's `.mcp.json`, using an absolute
CLI path and the diagram name:

```json
{
  "mcpServers": {
    "scope-diagram": {
      "command": "/absolute/path/to/irudd-scope",
      "args": ["diagram", "watch", "NAME", "--claude-channel"]
    }
  }
}
```

Supply remote Scope connection settings through this server's `env` when needed.
Launch Claude with
`claude --dangerously-load-development-channels server:scope-diagram` for a
custom development channel. This preview feature also depends on the account
and organization's channel policy. The adapter speaks MCP over stdio and sends
`notifications/claude/channel`. Claude owns the process and its lifetime.
Claude can receive a notice while idle or between active turns; a closed session
cannot wake. Use the same CLI working file and conflict workflow for replies.
