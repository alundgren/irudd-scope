# Agent connections

`irudd-scope diagram watch NAME` holds one background event connection to Scope,
including through a paired hub. It emits compact notices for human canvas edits,
messages, and proposal decisions. Agent writes do not echo back as human edits.
Bursts coalesce for 800 ms. On reconnect it checks the version once; missed canvas
changes can be recovered by rebasing. Messages are transient and have no replay
guarantee. Scope chat retains the conversation in its tab.

Stop the listener when the task ends. It also stops when the named tab is deleted
or its working directory disappears. Run it from the worktree. Listeners store
no global model or event cache. Use one destination per listener.

## T3 Code

Use T3's normal `t3 pair` flow to obtain a scoped bearer, stored in a private
token file. The required scopes are `orchestration:read` and
`orchestration:operate`. Keep credentials out of command arguments and logs.
Take the T3 thread ID from the active thread URL, and verify the thread's
worktree before connecting; the provider's Codex thread ID is different.

```sh
irudd-scope diagram watch NAME --t3-thread THREAD_ID \
  --t3-endpoint http://127.0.0.1:3773 --t3-token-file /private/token-file
```

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
