"""Synthetic native histories exercised through the public helper's CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "retro_sessions.py"
START = "2026-10-01T08:00:00.000Z"
END = "2026-10-01T08:00:03.000Z"
ORIGIN = "git@GitHub.com:Operator/Project.git"


class NativeSessionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "sessions").mkdir()
        (self.root / "projects" / "project").mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def run_helper(self, command="inventory", runtime="codex", extra=(), environment=None, succeeds=True):
        arguments = [sys.executable, str(SCRIPT), command, "--source-id", "test"]
        if command != "destinations":
            arguments += ["--runtime", runtime, "--root", str(self.root)]
        process = subprocess.run(arguments + list(extra), capture_output=True, text=True, env=environment)
        self.assertEqual(process.returncode, 0 if succeeds else 1, process.stderr)
        return json.loads(process.stdout if succeeds else process.stderr)

    def write(self, path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return path

    def codex(self, session="session", origin=ORIGIN, start=START, extra=None, records=(), archived=False):
        metadata = {"id": session, "timestamp": start, "cwd": "/nonexistent-synthetic-checkout", "git": {"repository_url": origin}}
        metadata.update(extra or {})
        return self.write(self.root / ("archived_sessions" if archived else "sessions") / (session + ".jsonl"),
                          [{"type": "session_meta", "payload": metadata}] + list(records))

    def claude(self, session="claude-session", rows=(), first=None, path=None):
        initial = {"type": "user", "sessionId": session, "cwd": "/nonexistent-synthetic-checkout", "gitOrigin": ORIGIN,
                   "parentUuid": None, "timestamp": START, "uuid": "first", "message": {"role": "user", "content": "Please fix the test"}}
        initial.update(first or {})
        return self.write(path or self.root / "projects" / "project" / (session + ".jsonl"), [initial] + [{"sessionId": initial["sessionId"], **row} for row in rows])

    def usage(self, total=100):
        return {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {
            "input_tokens": total - 20, "cached_input_tokens": 10, "output_tokens": 20, "total_tokens": total}}}}

    def assistant(self, text="Done"):
        return {"timestamp": END, "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}}

    def test_inventory_metadata_only_and_archives(self):
        self.codex(records=[self.assistant("NEVER INCLUDE THIS CONVERSATION IN INVENTORY")])
        self.codex("archived", archived=True)
        result = self.run_helper()
        self.assertTrue(result["inventoryComplete"])
        self.assertEqual(result["sessionCount"], 2)
        self.assertEqual(result["sessions"][0]["repository"], "github.com/operator/project")
        self.assertNotIn("NEVER INCLUDE", json.dumps(result))

    def test_current_audited_retro_agent_children_and_unassociated_excluded(self):
        for session in ("current", "audited", "retro-agent", "kept"):
            self.codex(session)
        self.codex("child", extra={"source": {"subagent": {"thread_spawn": {"parent_thread_id": "kept"}}}})
        self.codex("unknown-origin", origin="file:///tmp/local")
        tracking = self.root / "tracking.json"
        tracking.write_text(json.dumps({"audited": ["audited"], "agents": ["retro-agent"]}))
        result = self.run_helper(extra=["--current-session", "current", "--tracking", str(tracking)])
        self.assertEqual([row["sessionId"] for row in result["sessions"]], ["kept"])
        self.assertEqual(result["ignored"]["child"], 1)
        self.assertEqual(result["ignored"]["excluded"], 3)
        self.assertEqual(result["ignored"]["unassociated"], 1)

    def test_from_now_unknown_start_not_inferred_from_activity(self):
        self.codex("unknown", start=None)
        self.codex("equal")
        self.codex("later", start="2026-10-01T08:00:01Z")
        tracking = self.root / "tracking.json"
        tracking.write_text(json.dumps({"mode": "from-now", "cutoff": START}))
        result = self.run_helper(extra=["--tracking", str(tracking)])
        self.assertEqual([row["sessionId"] for row in result["sessions"]], ["later"])
        self.assertEqual(result["ignored"]["unknownStart"], 1)
        self.assertEqual(result["ignored"]["beforeCutoff"], 1)

    def test_unknown_start_in_all_history_stays_null(self):
        self.codex(start=None)
        result = self.run_helper()
        self.assertIsNone(result["sessions"][0]["startedAt"])
        self.assertIsNotNone(result["sessions"][0]["lastActivityAt"])

    def test_pagination_cutoff_stable_and_active_excluded_log_can_change(self):
        for session in ("a", "b", "c", "current"):
            self.codex(session)
        first = self.run_helper(extra=["--page-size", "2", "--current-session", "current"])
        with (self.root / "sessions" / "current.jsonl").open("a") as stream:
            stream.write(json.dumps(self.assistant()) + "\n")
        second = self.run_helper(extra=["--page-size", "2", "--current-session", "current", "--after", first["next"]])
        self.assertEqual(second["discoveredAt"], first["discoveredAt"])
        self.assertEqual([row["sessionId"] for row in first["sessions"] + second["sessions"]], ["a", "b", "c"])
        self.assertIsNone(second["next"])

    def test_changed_eligible_inventory_requires_restart(self):
        self.codex("a")
        self.codex("b")
        first = self.run_helper(extra=["--page-size", "1"])
        self.codex("c")
        result = self.run_helper(extra=["--page-size", "1", "--after", first["next"]], succeeds=False)
        self.assertIn("restart", result["error"])

    def test_missing_root_not_successful_empty(self):
        result = self.run_helper(extra=["--root", str(self.root / "missing")], succeeds=False)
        self.assertFalse(result["inventoryComplete"])

    def test_corrupt_header_is_incomplete(self):
        self.codex()
        (self.root / "sessions" / "corrupt.jsonl").write_text("not json\n")
        result = self.run_helper()
        self.assertFalse(result["inventoryComplete"])
        self.assertEqual(len(result["coverage"]["unreadableHeaders"]), 1)

    def test_unreadable_header_examples_are_bounded_without_hiding_failure(self):
        for number in range(25):
            (self.root / "sessions" / (str(number) + ".jsonl")).write_text("not json\n")
        result = self.run_helper()
        self.assertFalse(result["inventoryComplete"])
        self.assertEqual(result["coverage"]["unreadableHeaderCount"], 25)
        self.assertEqual(len(result["coverage"]["unreadableHeaders"]), 20)

    def test_tracking_page_not_silently_partial(self):
        tracking = self.root / "tracking.json"
        tracking.write_text(json.dumps({"audited": [], "next": "another-page"}))
        result = self.run_helper(extra=["--tracking", str(tracking)], succeeds=False)
        self.assertIn("incomplete", result["error"])

    def test_duplicate_native_ids_not_successful_complete_inventory_or_snapshot(self):
        self.codex("same")
        self.codex("same", archived=True)
        self.assertFalse(self.run_helper()["inventoryComplete"])
        self.run_helper("snapshot", extra=["--session-id", "same"], succeeds=False)

    def test_git_cwd_lookup_groups_worktrees(self):
        checkout = self.root / "checkout"
        checkout.mkdir()
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "remote", "add", "origin", "ssh://git@GitHub.com:22/Operator/Project.git"], check=True)
        self.codex(origin=None, extra={"cwd": str(checkout)})
        self.assertEqual(self.run_helper()["sessions"][0]["repository"], "github.com/operator/project")

    def test_non_github_case_ports_and_forks_preserved(self):
        self.codex("one", origin="ssh://git@Git.Example:2222/Group/Project.git")
        self.codex("two", origin="https://github.com/SomeoneElse/Project.git")
        rows = self.run_helper()["sessions"]
        self.assertEqual(rows[0]["repository"], "git.example:2222/Group/Project")
        self.assertEqual(rows[1]["repository"], "github.com/someoneelse/project")

    def test_github_only_transport_default_ports_normalize(self):
        origins = {"https-default": "https://GitHub.com:443/Owner/Repo.git", "ssh-default": "ssh://git@GitHub.com:22/Owner/Repo.git", "https-unusual": "https://github.com:22/Owner/Repo.git", "ssh-unusual": "ssh://git@github.com:443/Owner/Repo.git"}
        for name, origin in origins.items():
            self.codex(name, origin=origin)
        repositories = {row["sessionId"]: row["repository"] for row in self.run_helper()["sessions"]}
        self.assertEqual(repositories["https-default"], "github.com/owner/repo")
        self.assertEqual(repositories["ssh-default"], "github.com/owner/repo")
        self.assertEqual(repositories["https-unusual"], "github.com:22/Owner/Repo")
        self.assertEqual(repositories["ssh-unusual"], "github.com:443/Owner/Repo")

    def test_unknown_tracking_mode_rejected(self):
        tracking = self.root / "tracking.json"
        tracking.write_text(json.dumps({"mode": "bad-mode", "cutoff": START}))
        self.assertIn("Unknown", self.run_helper(extra=["--tracking", str(tracking)], succeeds=False)["error"])

    def test_unsupported_origins_not_repaired_into_wrong_repository(self):
        for index, origin in enumerate(("https://github.com/a/../b", "https://github.com/a/b?token=value", "https://github.com/a/b%2Fc", "https://bad_host/a/b", "https://github.com/a")):
            self.codex(str(index), origin=origin)
        self.assertEqual(self.run_helper()["sessionCount"], 0)

    def test_snapshot_explicit_id_not_latest(self):
        self.codex("old", records=[self.assistant("Older evidence")])
        self.codex("new", records=[self.assistant("New evidence")])
        result = self.run_helper("snapshot", extra=["--session-id", "old"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["conversations"][0]["text"], "Older evidence")
        self.run_helper("snapshot", extra=["--session-id", "missing"], succeeds=False)

    def test_codex_cumulative_samples_never_summed(self):
        self.codex(records=[self.assistant(), self.usage(100), self.usage(100), self.usage(150)])
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertEqual(result["metrics"][0]["value"], 150)
        self.assertEqual(result["metrics"][0]["certainty"], "exact")

    def test_codex_missing_or_reset_or_fork_usage_unknown(self):
        for extra, records in (({}, [self.assistant()]), ({}, [self.assistant(), self.usage(100), self.usage(50)]), ({"forked_from_id": "ancestor"}, [self.assistant(), self.usage(100)])):
            self.codex(extra=extra, records=records)
            metric = self.run_helper("snapshot", extra=["--session-id", "session"])["metrics"][0]
            self.assertIsNone(metric["value"])
            self.assertEqual(metric["certainty"], "unknown")

    def test_codex_counter_before_last_response_is_subtotal(self):
        self.codex(records=[self.usage(100), self.assistant()])
        self.assertEqual(self.run_helper("snapshot", extra=["--session-id", "session"])["metrics"][0]["certainty"], "estimated")

    def test_counter_before_model_tool_call_is_estimated_until_updated(self):
        call = {"type": "response_item", "payload": {"type": "function_call", "call_id": "call", "name": "exec_command", "arguments": "test"}}
        self.codex(records=[self.usage(), call])
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertEqual(result["metrics"][0]["value"], 100)
        self.assertEqual(result["metrics"][0]["certainty"], "estimated")
        self.codex(records=[self.usage(), call, self.usage(150)])
        self.assertEqual(self.run_helper("snapshot", extra=["--session-id", "session"])["metrics"][0]["certainty"], "exact")

    def test_selected_corrupt_history_fails_without_invalidating_unrelated_exact_usage(self):
        selected = self.codex(records=[self.assistant(), self.usage()])
        (self.root / "sessions" / "unrelated.jsonl").write_text("corrupt header\n")
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["metrics"][0]["certainty"], "exact")
        with selected.open("a") as stream:
            stream.write("broken final record\n")
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["metrics"][0]["certainty"], "estimated")

    def test_native_tools_waits_and_coverage(self):
        call = {"timestamp": START, "type": "response_item", "payload": {"type": "function_call", "call_id": "test-call", "name": "exec_command", "arguments": '{"cmd":"vp run test"}'}}
        output = {"timestamp": END, "type": "response_item", "payload": {"type": "function_call_output", "call_id": "test-call", "output": "Tests passed"}}
        self.codex(records=[call, output, self.assistant(), self.usage()])
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertEqual(result["tools"][0]["output"], "Tests passed")
        self.assertEqual(result["tools"][0]["elapsedSeconds"], 3)
        self.assertEqual(result["metrics"][2]["certainty"], "estimated")

    def test_codex_builtin_tools_retained_without_invented_duration(self):
        web = {"timestamp": END, "type": "response_item", "payload": {"type": "web_search_call", "id": "web", "status": "completed", "action": {"type": "search", "query": "official docs"}}}
        search = {"timestamp": START, "type": "response_item", "payload": {"type": "tool_search_call", "call_id": "search", "arguments": {"query": "docs"}}}
        output = {"timestamp": END, "type": "response_item", "payload": {"type": "tool_search_output", "call_id": "search", "tools": [{"name": "docs"}]}}
        self.codex(records=[web, search, output])
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        tools = {tool["id"]: tool for tool in result["tools"]}
        self.assertEqual(result["metrics"][1]["value"], 2)
        self.assertEqual(tools["web"]["input"]["query"], "official docs")
        self.assertIsNone(tools["web"]["elapsedSeconds"])
        self.assertEqual(tools["search"]["output"], [{"name": "docs"}])

    def test_claude_root_start_and_child_exclusion(self):
        self.claude()
        self.claude("missing-start", first={"parentUuid": "earlier-not-in-this-file"})
        self.claude("child", first={"isSidechain": True, "agentId": "child-agent", "parentSessionId": "claude-session"}, path=self.root / "projects" / "project" / "claude-session" / "subagents" / "agent-child.jsonl")
        result = self.run_helper(runtime="claude")
        self.assertEqual(result["sessionCount"], 2)
        self.assertEqual(result["sessions"][0]["startedAt"], START)
        self.assertIsNone(result["sessions"][1]["startedAt"])
        self.assertEqual(result["ignored"]["child"], 1)

    def test_claude_streaming_usage_counted_once_latest_even_same_uuid(self):
        def assistant(output):
            return {"type": "assistant", "uuid": "same", "timestamp": END, "message": {"id": "response", "role": "assistant", "content": [{"type": "text", "text": "Done"}], "usage": {"input_tokens": 10, "output_tokens": output, "cache_creation_input_tokens": 4, "cache_read_input_tokens": 6}}}
        self.claude(rows=[assistant(0), assistant(5), assistant(5)])
        result = self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])
        self.assertEqual(result["metrics"][0]["value"], 25)
        self.assertEqual(result["metrics"][0]["certainty"], "exact")
        self.assertEqual(len(result["conversations"]), 2)

    def test_later_unusable_streaming_usage_is_unknown_until_valid_update(self):
        def message(usage):
            return {"type": "assistant", "message": {"id": "stream", "role": "assistant", "content": "More evidence", "usage": usage}}
        for broken in (None, {"input_tokens": 10}):
            rows = [message({"input_tokens": 10, "output_tokens": 5}), message(broken)]
            self.claude(rows=rows)
            result = self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])
            self.assertIsNone(result["metrics"][0]["value"])
            self.assertEqual(result["metrics"][0]["certainty"], "unknown")
            self.assertEqual(result["coverage"]["usageMessagesMissing"], 1)
            self.claude(rows=rows + [message({"input_tokens": 10, "output_tokens": 8})])
            result = self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])
            self.assertEqual(result["metrics"][0]["value"], 18)
            self.assertEqual(result["metrics"][0]["certainty"], "exact")

    def test_claude_partial_usage_subtotal_and_no_usage_unknown(self):
        known = {"type": "assistant", "message": {"id": "known", "role": "assistant", "content": "Done", "usage": {"input_tokens": 10, "output_tokens": 5}}}
        missing = {"type": "assistant", "message": {"id": "missing", "role": "assistant", "content": "More"}}
        self.claude(rows=[known, missing])
        metric = self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])["metrics"][0]
        self.assertEqual(metric["value"], 15)
        self.assertEqual(metric["certainty"], "estimated")
        self.claude(rows=[missing])
        self.assertIsNone(self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])["metrics"][0]["value"])

    def test_claude_native_tool_blocks_and_explicit_child_coverage(self):
        assistant = {"type": "assistant", "timestamp": START, "message": {"id": "tools", "role": "assistant", "content": [{"type": "tool_use", "id": "call", "name": "Bash", "input": {"command": "pytest"}}]}}
        user = {"type": "user", "timestamp": END, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call", "content": "2 passed"}]}}
        self.claude(rows=[assistant, user])
        self.claude("child", first={"isSidechain": True, "agentId": "agent-child", "parentSessionId": "claude-session"})
        result = self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])
        self.assertEqual(result["tools"][0]["elapsedSeconds"], 3)
        self.assertEqual(result["coverage"]["linkedChildren"][0]["sessionId"], "agent-child")
        self.assertNotIn("2 passed", str(result["conversations"]))

    def test_no_supported_content_not_complete(self):
        self.codex()
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertFalse(result["complete"])
        self.assertIsNone(result["metrics"][0]["value"])

    def test_native_size_bound_not_partial_success(self):
        path = self.codex(records=[self.assistant()])
        with path.open("ab") as stream:
            stream.truncate(33 * 1024 * 1024)
        result = self.run_helper("snapshot", extra=["--session-id", "session"], succeeds=False)
        self.assertIn("byte limit", result["error"])

    def test_foreign_or_missing_claude_identity_is_not_credited(self):
        foreign = {"sessionId": "other", "type": "assistant", "message": {"id": "foreign", "role": "assistant", "content": "Foreign evidence", "usage": {"input_tokens": 10, "output_tokens": 20}}}
        self.claude(rows=[foreign])
        result = self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])
        self.assertFalse(result["complete"])
        self.assertNotIn("Foreign evidence", str(result["conversations"]))
        self.assertIsNone(result["metrics"][0]["value"])
        self.assertTrue(result["coverage"]["problems"])
        foreign["sessionId"] = None
        self.claude(rows=[foreign])
        self.assertFalse(self.run_helper("snapshot", "claude", ["--session-id", "claude-session"])["complete"])

    def test_child_snapshot_uses_its_native_identity_and_rejects_other_agents(self):
        message = {"type": "assistant", "agentId": "child-agent", "message": {"id": "response", "role": "assistant", "content": "Child evidence", "usage": {"input_tokens": 10, "output_tokens": 20}}}
        self.claude("parent-native-id", first={"isSidechain": True, "agentId": "child-agent"}, rows=[message], path=self.root / "projects" / "project" / "parent-native-id" / "subagents" / "agent-child-agent.jsonl")
        result = self.run_helper("snapshot", "claude", ["--session-id", "child-agent"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["metrics"][0]["value"], 30)
        self.claude("parent-native-id", first={"isSidechain": True}, rows=[message], path=self.root / "projects" / "project" / "parent-native-id" / "subagents" / "agent-child-agent.jsonl")
        self.assertTrue(self.run_helper("snapshot", "claude", ["--session-id", "child-agent"])["complete"])
        message["agentId"] = "other-agent"
        self.claude("parent-native-id", first={"isSidechain": True}, rows=[message], path=self.root / "projects" / "project" / "parent-native-id" / "subagents" / "agent-child-agent.jsonl")
        self.assertFalse(self.run_helper("snapshot", "claude", ["--session-id", "child-agent"])["complete"])

    def test_malformed_counter_does_not_leave_old_usage_exact(self):
        broken = {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 100, "total_tokens": 120}}}}
        self.codex(records=[self.assistant(), self.usage(), broken])
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertIsNone(result["metrics"][0]["value"])
        self.assertEqual(result["metrics"][0]["certainty"], "unknown")
        self.assertTrue(result["coverage"]["usageProblems"])

    def test_rejected_recorded_origin_cannot_be_replaced_by_new_cwd_origin(self):
        checkout = self.root / "checkout"
        checkout.mkdir()
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "remote", "add", "origin", "https://github.com/new/current"], check=True)
        self.codex(origin="https://github.com/old/original?unsupported=query", extra={"cwd": str(checkout)})
        self.assertEqual(self.run_helper()["sessionCount"], 0)

    def test_invalid_url_port_is_unassociated(self):
        self.codex(origin="https://git.example:99999/Team/Project.git")
        self.assertEqual(self.run_helper()["sessionCount"], 0)

    def test_from_now_preserves_fractional_precision_and_timestamp_order(self):
        self.codex("equal", start=START)
        self.codex("nanosecond", start="2026-10-01T08:00:00.000000001Z")
        self.codex("microsecond", start="2026-10-01T08:00:00.000001Z")
        tracking = self.root / "tracking.json"
        tracking.write_text(json.dumps({"mode": "from-now", "cutoff": START}))
        result = self.run_helper(extra=["--tracking", str(tracking)])
        self.assertEqual(result["sessionCount"], 2)
        self.assertEqual(result["oldestStartedAt"], "2026-10-01T08:00:00.000000001Z")

    def test_resume_metadata_does_not_change_native_creation(self):
        later_meta = {"type": "session_meta", "payload": {"id": "session", "timestamp": "2026-10-02T00:00:00Z", "git": {"repository_url": ORIGIN}}}
        self.codex(records=[later_meta])
        self.assertEqual(self.run_helper()["sessions"][0]["startedAt"], START)

    def test_archive_only_root_is_available_but_missing_both_is_not(self):
        (self.root / "sessions").rmdir()
        self.codex(archived=True)
        self.assertTrue(self.run_helper()["inventoryComplete"])
        self.assertEqual(self.run_helper()["sessionCount"], 1)

    def test_unsupported_message_content_is_incomplete(self):
        unknown = {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "future-content", "value": "Unknown native evidence"}]}}
        self.codex(records=[unknown])
        result = self.run_helper("snapshot", extra=["--session-id", "session"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["conversations"], [])
        self.assertTrue(any("Unsupported" in note for note in result["coverage"]["problems"]))

    def fake_environment(self, names):
        directory = Path(tempfile.mkdtemp(dir=self.root))
        for name in names:
            path = directory / name
            path.write_text("#!/bin/sh\nexit 0\n")
            path.chmod(0o755)
        return {**os.environ, "PATH": str(directory), "CODEX_HOME": str(self.root / "codex-config"), "CLAUDE_CONFIG_DIR": str(self.root / "claude-config")}

    def test_destinations_do_not_invent_native_memory_or_missing_okf(self):
        result = self.run_helper("destinations", environment=self.fake_environment(["codex", "claude"]))
        self.assertEqual({row["type"] for row in result["destinations"]}, {"codex-instructions", "instructions"})
        self.assertIsNone(result["capabilities"]["okfExecutable"])
        self.assertFalse((self.root / "codex-config").exists())
        self.assertFalse((self.root / "claude-config").exists())

    def test_claude_memory_requires_runtime_confirmed_directory(self):
        memory = self.root / "custom-memory"
        memory.mkdir()
        project = self.root / "checkout"
        project.mkdir()
        result = self.run_helper("destinations", extra=["--project", str(project), "--repository", "github.com/operator/project", "--claude-memory-path", str(memory)], environment=self.fake_environment(["claude"]))
        destination = next(row for row in result["destinations"] if row["type"] == "claude-memory")
        self.assertEqual(destination["path"], str(memory))
        self.assertEqual(destination["repository"], "github.com/operator/project")
        self.assertTrue(destination["available"])
        result = self.run_helper("destinations", extra=["--project", str(project), "--repository", "github.com/operator/project", "--claude-memory-path", str(memory / "missing")], environment=self.fake_environment(["claude"]))
        self.assertFalse(next(row for row in result["destinations"] if row["type"] == "claude-memory")["available"])

    def test_okf_executable_detection_not_assumed_store(self):
        environment = self.fake_environment(["irudd-okf"])
        result = self.run_helper("destinations", environment=environment)
        self.assertTrue(result["capabilities"]["okfExecutable"].endswith("irudd-okf"))
        self.assertEqual(result["destinations"], [])
        store = self.root / "verified-store"
        store.mkdir()
        result = self.run_helper("destinations", extra=["--okf-store", str(store)], environment=environment)
        self.assertEqual(result["destinations"][0], {**result["destinations"][0], "type": "okf", "scope": "operator", "path": str(store.resolve()), "available": True})
        result = self.run_helper("destinations", extra=["--okf-store", str(store)], environment=self.fake_environment([]))
        self.assertIsNone(result["capabilities"]["okfExecutable"])
        self.assertEqual(result["destinations"], [])

    def test_okf_store_is_absolute_and_project_bundles_stay_inside_the_checkout(self):
        environment = self.fake_environment(["irudd-okf"])
        project = self.root / "checkout"
        bundle = project / ".okf"
        bundle.mkdir(parents=True)
        outside = self.root / "personal-okf"
        outside.mkdir()
        repository = ["--project", str(project), "--repository", "github.com/operator/project"]
        result = self.run_helper("destinations", extra=[*repository, "--okf-store", str(bundle), "--okf-scope", "project"], environment=environment)
        destination = next(row for row in result["destinations"] if row["type"] == "okf")
        self.assertEqual((destination["id"], destination["scope"], destination["repository"]), ("okf-project", "project", "github.com/operator/project"))
        for extra in (["--okf-store", "relative-store"], [*repository, "--okf-store", str(outside), "--okf-scope", "project"], ["--okf-store", str(bundle), "--okf-scope", "project"]):
            self.assertIn("OKF", self.run_helper("destinations", extra=extra, environment=environment, succeeds=False)["error"])


if __name__ == "__main__":
    unittest.main()
