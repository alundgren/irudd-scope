# Agent connections

For retrospectives, use `irudd-scope retro watch NAME` with the host flags
below. It delivers the person's decisions, comments and pending investigation
requests. Notices may repeat after a listener restart, so identify work by the
durable record IDs from `retro read NAME`. The listener reports
`Listening for retrospective decisions on NAME.` Scope does not start agent
sessions.

Connect the listener before handing a retrospective back for review. Verify
that readiness message in the managed process log. A successful publication
saves data but does not establish an agent connection. Without host flags,
`retro watch` prints notices to stdout only.

Stop the listener when the task ends. It also stops when the named retrospective is finished or deleted
or its working directory disappears. Run it from the worktree. Listeners store
no global model or event cache. Use one destination per listener. The listener
holds no model turn open. Do not keep a tool call waiting or poll it in an agent
loop. Start it under the session host or a service manager that survives tool
cleanup; shell backgrounding and `nohup` alone may not survive that cleanup.

## T3 Code

Use the T3 destination for every agent running inside T3, including Claude and
Codex. `--claude-channel` is for a direct Claude Code channel, and
`--codex-thread` is for a direct Codex App Server session. Neither connects a T3
thread. The T3 listener preserves the thread's permission and interaction modes,
including Auto and Accept edits.

Use T3's normal `t3 pair` flow to obtain a scoped bearer, stored in a private
token file. The required scopes are `orchestration:read` and
`orchestration:operate`. Keep credentials out of command arguments and logs.
Take the T3 thread ID from the active thread URL, and verify the thread's
worktree before connecting; the provider's Codex thread ID is different.

```sh
irudd-scope retro watch NAME --t3-thread THREAD_ID \
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
systemd-run --user --collect --unit=scope-retro-NAME \
  --working-directory="$PWD" \
  --setenv=SCOPE_CONNECTION_FILE=/absolute/path/to/desktop.json \
  /absolute/path/to/irudd-scope retro watch NAME --t3-thread THREAD_ID \
  --t3-endpoint http://T3_ADDRESS:3773 --t3-token-file /private/token-file
journalctl --user -u scope-retro-NAME -n 10 --no-pager
```

Verify `Listening for retrospective decisions on NAME.` in the log before reporting a
connection. When the task ends, run `systemctl --user stop scope-retro-NAME`. Do not enable automatic
restart after a host delivery error: inspect the thread before reconnecting so
an uncertain request is not repeated. On other hosts, use their managed process
facility with the same lifetime and cleanup rules.

Reconnecting rereads the saved decisions, comments and pending requests.

T3 receives a user follow-up through its authenticated orchestration API.
Delivery while busy follows T3's queue behavior. Its command ID remains the
same for an ambiguous retry. Revoke temporary sessions with T3's auth CLI when
testing is done. T3's API can change independently of Scope.

## Codex App Server

The session host must expose a reachable App Server WebSocket and an existing
thread. Connecting to an unrelated App Server does not wake a terminal session
owned by another process. Use the host's thread ID and endpoint:

```sh
irudd-scope retro watch NAME --codex-thread THREAD_ID --codex-url ws://127.0.0.1:4500
```

Scope starts a turn when idle and steers the active turn using its expected
turn ID. A failed or uncertain delivery stops the listener and reports an
error; inspect the thread before restarting. A standalone Codex terminal has
no universal external wake-up endpoint. Use T3's adapter for T3 sessions.

## Claude Code channels

Register a local stdio MCP server in the project's `.mcp.json`, using an absolute
CLI path and the retrospective name:

```json
{
  "mcpServers": {
    "scope-retro": {
      "command": "/absolute/path/to/irudd-scope",
      "args": ["retro", "watch", "NAME", "--claude-channel"]
    }
  }
}
```

Supply remote Scope connection settings through this server's `env` when needed.
Launch Claude with
`claude --dangerously-load-development-channels server:scope-retro` for a
custom development channel. This preview feature also depends on the account
and organization's channel policy. The adapter speaks MCP over stdio and sends
`notifications/claude/channel`. Claude owns the process and its lifetime.
Claude can receive a notice while idle or between active turns; a closed session
cannot wake.
