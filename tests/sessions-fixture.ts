import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The parts of T3 Code's state database the Agent sessions tab reads. */
const SCHEMA = `
create table projection_projects (project_id text primary key, title text);
create table orchestration_v2_projection_threads (thread_id text primary key, project_id text, title text, created_at text, updated_at text, deleted_at text);
create table orchestration_v2_projection_subagents (thread_id text, child_thread_id text, origin text, updated_at text);
create table orchestration_v2_projection_runs (run_id text primary key, thread_id text, ordinal integer, provider text, status text, requested_at text, completed_at text, payload_json text);
create table orchestration_v2_projection_run_attempts (attempt_id text primary key, run_id text);
create table orchestration_v2_projection_provider_turns (provider_turn_id text primary key, run_attempt_id text, started_at text, completed_at text, payload_json text);
create table orchestration_v2_projection_turn_items (thread_id text, provider_turn_id text, run_id text, ordinal integer, type text, status text, payload_json text, updated_at text);
create table orchestration_v2_projection_messages (thread_id text, role text, payload_json text, streaming integer, created_at text);
create table orchestration_v2_projection_provider_threads (thread_id text, payload_json text, updated_at text);
`;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/**
 * A home with T3 Code history for two projects. In `game`, "Build the slice" has a delegated
 * child thread and a Claude Code subagent whose tool calls exist only in its log. In `site`,
 * one thread ran `vp run check`. Inputs, outputs and messages hold secrets that must stay
 * hidden.
 */
export async function sessionsHome() {
  const root = await mkdtemp(join(tmpdir(), "scope-sessions-"));
  const home = join(root, "home");
  const markers: string[] = [];
  const secret = () => {
    const value = `ghp_${randomUUID().replace(/-/g, "")}`;
    markers.push(value);
    return value;
  };
  const file = async (path: string, content: string) => {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), content);
  };
  await file(
    ".t3/userdata/usage-model-rates.json",
    JSON.stringify({
      document: {
        "claude-opus-5-5": {
          input_cost_per_token: 0.000005,
          cache_read_input_token_cost: 0.0000005,
          cache_creation_input_token_cost: 0.00000625,
          cache_creation_input_token_cost_above_1hr: 0.00001,
          output_cost_per_token: 0.000025,
        },
      },
    }),
  );
  const db = new DatabaseSync(join(home, ".t3/userdata/statev2.sqlite"));
  db.exec(SCHEMA);
  const insert = (table: string, row: Record<string, string | number | null>) =>
    db
      .prepare(
        `insert into ${table} (${Object.keys(row).join(",")}) values (${Object.keys(row)
          .map(() => "?")
          .join(",")})`,
      )
      .run(...Object.values(row));
  insert("projection_projects", { project_id: "p-game", title: "game" });
  insert("projection_projects", { project_id: "p-site", title: "site" });
  const subagent = "thread:provider:claudeAgent:session-1:agent0001";
  const threads: Array<[string, string, string]> = [
    ["t-build", "p-game", "Build the slice"],
    ["t-review", "p-game", "Review the slice"],
    [subagent, "p-game", "Scout the map code"],
    ["t-site", "p-site", "Fix the site check"],
    // Older than the time span: never shown.
    ["t-old", "p-site", "Ancient thread"],
  ];
  for (const [id, project, title] of threads)
    insert("orchestration_v2_projection_threads", {
      thread_id: id,
      project_id: project,
      title,
      created_at: at(id === "t-old" ? 20_000 : 120),
      updated_at: at(id === "t-old" ? 20_000 : 5),
      deleted_at: null,
    });
  insert("orchestration_v2_projection_subagents", {
    thread_id: "t-build",
    child_thread_id: "t-review",
    origin: "app_owned",
    updated_at: at(5),
  });
  insert("orchestration_v2_projection_subagents", {
    thread_id: "t-build",
    child_thread_id: subagent,
    origin: "provider_native",
    updated_at: at(5),
  });
  insert("orchestration_v2_projection_provider_threads", {
    thread_id: "t-build",
    payload_json: JSON.stringify({ nativeThreadRef: { nativeId: "session-1" } }),
    updated_at: at(5),
  });

  let item = 0;
  const run = (thread: string, ordinal: number, start: number, end: number, output: number) => {
    const id = `${thread}-run-${ordinal}`;
    insert("orchestration_v2_projection_runs", {
      run_id: id,
      thread_id: thread,
      ordinal,
      provider: "claudeAgent",
      status: "completed",
      requested_at: at(start),
      completed_at: at(end),
      payload_json: JSON.stringify({
        modelSelection: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
      }),
    });
    insert("orchestration_v2_projection_run_attempts", { attempt_id: `${id}-a`, run_id: id });
    insert("orchestration_v2_projection_provider_turns", {
      provider_turn_id: `${id}-turn`,
      run_attempt_id: `${id}-a`,
      started_at: at(start),
      completed_at: at(end),
      payload_json: JSON.stringify({
        turnTokenUsage: {
          inputTokens: 100_000,
          cachedInputTokens: 90_000,
          cacheCreationTokens: 5_000,
          outputTokens: output,
        },
        tokenUsage: { usedTokens: 50_000, maxTokens: 1_000_000 },
      }),
    });
    return (command: string, out: string, exitCode: number, seconds: number) => {
      const started = new Date(Date.now() - start * 60_000 + 1000);
      insert("orchestration_v2_projection_turn_items", {
        thread_id: thread,
        provider_turn_id: `${id}-turn`,
        run_id: id,
        ordinal: ++item,
        type: "command_execution",
        status: exitCode === 0 ? "completed" : "failed",
        payload_json: JSON.stringify({
          input: command,
          output: out,
          exitCode,
          startedAt: started.toISOString(),
          completedAt: new Date(started.getTime() + seconds * 1000).toISOString(),
        }),
        updated_at: at(5),
      });
    };
  };
  const build = run("t-build", 1, 120, 30, 8_000);
  build(`/bin/bash -lc 'cargo test -p map'`, "test result: ok. 40 passed", 0, 600);
  build(
    `/bin/bash -lc 'cargo test -p render'`,
    "running 3 tests\ntest result: FAILED. 2 passed; 1 failed",
    101,
    300,
  );
  build(`export TOKEN=${secret()}; cargo build`, `Compiling map\nleaked ${secret()}`, 0, 120);
  const review = run("t-review", 1, 60, 40, 2_000);
  review(
    `rg -n 'spawn' src; cat notes/review.md 2>/dev/null; rg -n 'TODO' src/map.rs`,
    "src/map.rs:10: spawn(world)",
    1,
    2,
  );
  const site = run("t-site", 1, 90, 80, 1_000);
  site("vp run check", "Format issues found in above 2 files.", 1, 40);
  const message = (thread: string, role: string, text: string, minutes: number) =>
    insert("orchestration_v2_projection_messages", {
      thread_id: thread,
      role,
      payload_json: JSON.stringify({ text }),
      streaming: 0,
      created_at: at(minutes),
    });
  message(
    "t-build",
    "user",
    `Build the first slice. Use key ${secret()} for the asset server.`,
    120,
  );
  message("t-build", "assistant", "The slice builds; render tests fail on one case.", 30);
  message("t-review", "user", "Review the slice. Run the full check before you answer.", 60);
  message("t-review", "assistant", "CHANGES REQUESTED: the map spawns twice.", 40);
  db.close();

  // The Claude Code subagent: T3 has its thread but neither its tokens nor its tool calls.
  const agentLog = [
    {
      type: "assistant",
      timestamp: at(100),
      message: {
        id: "msg-1",
        model: "claude-haiku-5-5",
        usage: { input_tokens: 10, cache_read_input_tokens: 20_000, output_tokens: 900 },
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "rg -n map src" } },
        ],
      },
    },
    {
      type: "user",
      timestamp: at(99),
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "src/map.rs:1" }],
      },
    },
  ];
  await file(
    ".claude/projects/game/session-1/subagents/agent-agent0001.jsonl",
    agentLog.map((line) => JSON.stringify(line)).join("\n"),
  );
  return { root, home, markers, env: { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv };
}
