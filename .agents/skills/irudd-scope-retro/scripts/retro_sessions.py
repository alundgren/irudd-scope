#!/usr/bin/env python3
"""Read native session metadata and explicitly selected history without storing it."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

HEADER_BYTES = 256 * 1024
HEADER_LINES = 64
MAX_FILES = 20000
MAX_ENTRIES = 100000
SNAPSHOT_BYTES = 32 * 1024 * 1024
OUTPUT_BYTES = 2 * 1024 * 1024
MAX_EVENTS = 10000


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            return None
        return date.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        return None


def canonical_repository(origin):
    if not isinstance(origin, str) or len(origin) > 4096:
        return None
    origin = origin.strip()
    if re.search(r"\s", origin):
        return None
    scp = re.fullmatch(r"(?:[^@/]+@)?([A-Za-z0-9.-]+):([^/].*)", origin)
    scheme = None
    if scp and "://" not in origin:
        host, path = scp.groups()
    else:
        try:
            url = urlsplit(origin)
            if url.scheme not in ("https", "http", "ssh", "git") or url.query or url.fragment:
                return None
            scheme = url.scheme
            host = url.netloc.rsplit("@", 1)[-1]
            path = url.path.lstrip("/")
        except ValueError:
            return None
    host = host.lower()
    if (scheme == "ssh" and host == "github.com:22") or (scheme == "https" and host == "github.com:443"):
        host = "github.com"
    path = path.rstrip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if host == "github.com":
        if len(path.split("/")) != 2:
            return None
        path = path.lower()
    result = host + "/" + path
    if len(result) > 512 or not re.fullmatch(r"[a-z0-9.-]+(?::[0-9]+)?/[A-Za-z0-9_.~/-]+", result):
        return None
    if any(part in ("", ".", "..") for part in path.split("/")):
        return None
    return result


def git_repository(cwd, cache):
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    if cwd not in cache:
        try:
            process = subprocess.run(
                ["git", "-C", cwd, "config", "--get", "remote.origin.url"],
                capture_output=True, text=True, timeout=2, check=False,
            )
            cache[cwd] = canonical_repository(process.stdout.strip()) if process.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            cache[cwd] = None
    return cache[cwd]


def file_list(root, runtime):
    directories = [root / "sessions", root / "archived_sessions"] if runtime == "codex" else [root / "projects"]
    if not directories[0].is_dir():
        raise ValueError("Selected native session directory is missing: " + str(directories[0]))
    files, errors, entries = [], [], 0
    for directory in directories:
        if not directory.exists():
            continue
        for folder, subdirs, names in os.walk(directory, onerror=lambda error: errors.append(str(error)), followlinks=False):
            subdirs.sort()
            names.sort()
            entries += len(subdirs) + len(names)
            if entries > MAX_ENTRIES:
                raise ValueError("Native directory entry limit reached; narrow or inspect the source manually")
            for name in names:
                if name.endswith(".jsonl"):
                    files.append(Path(folder) / name)
                    if len(files) > MAX_FILES:
                        raise ValueError("Native session file limit reached; inspect the source manually")
    if errors:
        raise ValueError("Native session directory is unreadable: " + errors[0])
    return sorted(files)


def header(path, runtime, source_id, cache):
    stat = path.stat()
    with path.open("rb") as stream:
        raw = stream.read(HEADER_BYTES + 1)
    lines = raw[:HEADER_BYTES].splitlines()[:HEADER_LINES]
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
        except (ValueError, UnicodeDecodeError):
            continue
    if runtime == "codex":
        metas = [row.get("payload", {}) for row in rows if row.get("type") == "session_meta"]
        metas = [meta for meta in metas if isinstance(meta, dict) and isinstance(meta.get("id"), str)]
        filename_id = re.search(r"([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$", path.name)
        candidates = [meta for meta in metas if not filename_id or meta["id"] == filename_id.group(1)]
        if not candidates:
            raise ValueError("No matching native session metadata in bounded header")
        meta = candidates[-1]
        session_id, cwd = meta["id"], meta.get("cwd")
        start = timestamp(meta.get("timestamp"))
        source = meta.get("source")
        parent = meta.get("parent_thread_id")
        if isinstance(source, dict) and isinstance(source.get("subagent"), dict):
            spawn = source["subagent"].get("thread_spawn", {})
            if isinstance(spawn, dict):
                parent = parent or spawn.get("parent_thread_id")
        child = bool(parent or (isinstance(source, dict) and "subagent" in source))
        git = meta.get("git") if isinstance(meta.get("git"), dict) else {}
        repository = canonical_repository(git.get("repository_url") or git.get("origin_url"))
        fork = meta.get("forked_from_id")
    else:
        candidates = [row for row in rows if isinstance(row.get("sessionId"), str) and row.get("type") in ("user", "assistant", "system")]
        if not candidates:
            raise ValueError("No native session identity in bounded header")
        meta = candidates[0]
        session_id, cwd = meta["sessionId"], meta.get("cwd")
        child = bool(meta.get("isSidechain") or "subagents" in path.parts or path.name.startswith("agent-"))
        parent = meta.get("parentSessionId")
        # A first root user message with no parent is native evidence of the beginning.
        first = next((row for row in candidates if row.get("type") == "user"), None)
        start = timestamp(first.get("timestamp")) if first and first.get("parentUuid", "missing") is None and not child else None
        repository = canonical_repository(meta.get("gitOrigin") or meta.get("gitOriginUrl"))
        fork = None
        if child:
            session_id = meta.get("agentId") or path.stem
    if not session_id or len(session_id) > 256:
        raise ValueError("Invalid native session ID")
    repository = repository or git_repository(cwd, cache)
    return {
        "sourceId": source_id, "runtime": runtime, "sessionId": session_id,
        "repository": repository, "startedAt": start,
        "lastActivityAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "status": "eligible", "evidence": "Native metadata; activity from file modification time",
        "nativePath": str(path), "cwd": cwd, "child": child,
        "parentSessionId": parent, "forkedFromId": fork,
        "signature": [stat.st_size, stat.st_mtime_ns],
    }


def discover(args):
    root = Path(args.root).expanduser().resolve()
    cache, records, unreadable = {}, [], []
    paths = file_list(root, args.runtime)
    for path in paths:
        try:
            records.append(header(path, args.runtime, args.source_id, cache))
        except (OSError, ValueError) as error:
            unreadable.append({"path": str(path), "reason": str(error)})
    records.sort(key=lambda row: (row["sessionId"], row["nativePath"]))
    digest = hashlib.sha256(json.dumps([records, unreadable], sort_keys=True).encode()).hexdigest()
    return records, unreadable, digest


def read_tracking(path):
    if not path:
        return {"audited": [], "agents": [], "mode": None, "cutoff": None}
    with Path(path).open() as stream:
        value = json.load(stream)
    if not isinstance(value, dict) or not all(isinstance(value.get(key, []), list) and all(isinstance(item, str) for item in value.get(key, [])) for key in ("audited", "agents")):
        raise ValueError("Tracking must be an object with audited and agents ID arrays")
    if value.get("mode") not in (None, "all", "from-now"):
        raise ValueError("Unknown tracking mode")
    if value.get("cutoff") is not None and timestamp(value["cutoff"]) is None:
        raise ValueError("Invalid tracking cutoff")
    if value.get("next"):
        raise ValueError("Tracking is incomplete; combine every Scope tracking page first")
    if value.get("mode") == "from-now" and timestamp(value.get("cutoff")) is None:
        raise ValueError("from-now tracking requires a valid native discovery cutoff")
    return value


def inventory(args):
    records, unreadable, _ = discover(args)
    tracking = read_tracking(args.tracking)
    excluded = set(tracking.get("audited", [])) | set(tracking.get("agents", []))
    if args.current_session:
        excluded.add(args.current_session)
    sessions, ignored, ids = [], {"child": 0, "excluded": 0, "unassociated": 0, "beforeCutoff": 0, "unknownStart": 0, "duplicate": 0}, set()
    cutoff = timestamp(tracking.get("cutoff"))
    for row in records:
        reason = None
        if row["child"]:
            reason = "child"
        elif row["sessionId"] in excluded:
            reason = "excluded"
        elif not row["repository"]:
            reason = "unassociated"
        elif tracking.get("mode") == "from-now" and row["startedAt"] is None:
            reason = "unknownStart"
        elif tracking.get("mode") == "from-now" and row["startedAt"] <= cutoff:
            reason = "beforeCutoff"
        elif row["sessionId"] in ids:
            reason = "duplicate"
        if reason:
            ignored[reason] += 1
        else:
            ids.add(row["sessionId"])
            sessions.append(row)
    # Cursor binds source, filters, and native metadata; changed discovery requires a new first page.
    selection = hashlib.sha256(json.dumps([sessions, unreadable, args.source_id, args.runtime, tracking, args.current_session], sort_keys=True).encode()).hexdigest()
    offset, discovered_at = 0, now()
    if args.after:
        try:
            cursor = json.loads(base64.urlsafe_b64decode(args.after))
            if cursor["selection"] != selection or not isinstance(cursor["offset"], int) or isinstance(cursor["offset"], bool) or not 0 <= cursor["offset"] <= len(sessions) or timestamp(cursor["discoveredAt"]) is None:
                raise ValueError("Inventory changed or cursor is invalid; restart metadata discovery")
            offset, discovered_at = cursor["offset"], cursor["discoveredAt"]
        except (ValueError, KeyError, TypeError):
            raise ValueError("Inventory changed or cursor is invalid; restart metadata discovery") from None
    page = sessions[offset:offset + args.page_size]
    end = offset + len(page)
    next_page = None
    if end < len(sessions):
        next_page = base64.urlsafe_b64encode(json.dumps({"selection": selection, "offset": end, "discoveredAt": discovered_at}).encode()).decode()
    rows = [{key: value for key, value in row.items() if key != "signature"} for row in page]
    return {
        "sourceId": args.source_id, "runtime": args.runtime, "discoveredAt": discovered_at,
        "inventoryComplete": not unreadable and ignored["duplicate"] == 0, "sessionCount": len(sessions),
        "oldestStartedAt": min((row["startedAt"] for row in sessions if row["startedAt"]), default=None),
        "sessions": rows, "next": next_page, "ignored": ignored,
        "coverage": {"nativeFiles": len(records) + len(unreadable), "unreadableHeaders": unreadable,
                     "limits": {"headerBytes": HEADER_BYTES, "headerLines": HEADER_LINES, "files": MAX_FILES}},
    }


def text_blocks(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text") and isinstance(block.get("text"), str))
    return ""


def numeric_usage(value, keys):
    if not isinstance(value, dict):
        return None
    if not all(isinstance(value.get(key), int) and not isinstance(value[key], bool) and value[key] >= 0 for key in keys):
        return None
    return {key: value[key] for key in keys}


def metric(name, unit, value, certainty, method, coverage):
    return {"name": name, "unit": unit, "value": value, "certainty": certainty,
            "method": method, "coverage": coverage, "evidence": "Native selected-session records"}


def snapshot(args):
    records, unreadable, _ = discover(args)
    matches = [row for row in records if row["sessionId"] == args.session_id]
    if len(matches) != 1:
        raise ValueError("Explicit native session ID must match exactly one readable file; found " + str(len(matches)))
    selected = matches[0]
    path = Path(selected["nativePath"])
    if selected["signature"][0] > SNAPSHOT_BYTES:
        raise ValueError("Selected session exceeds snapshot byte limit; inspect the native session manually")
    conversations, tools, problems = [], {}, []
    usage_records, cumulative, seen_rows, seen_text = {}, [], set(), set()
    unknown_usage, assistant_count, response_count, last_usage_response = 0, 0, 0, 0
    active_native = args.runtime != "codex"
    with path.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            if line_number > 200000:
                problems.append("Native record limit reached")
                break
            try:
                row = json.loads(raw)
                if not isinstance(row, dict):
                    raise ValueError("Native record is not an object")
            except (ValueError, UnicodeDecodeError):
                problems.append("Unreadable native record at line " + str(line_number))
                continue
            at = timestamp(row.get("timestamp"))
            if args.runtime == "codex":
                payload = row.get("payload", {})
                if not isinstance(payload, dict):
                    continue
                if row.get("type") == "session_meta":
                    active_native = payload.get("id") == args.session_id
                    continue
                if not active_native:
                    continue
                if row.get("type") == "response_item":
                    kind = payload.get("type")
                    if kind == "message" and payload.get("role") in ("user", "assistant"):
                        role = payload["role"]
                        conversations.append({"role": role, "text": text_blocks(payload.get("content")), "at": at, "line": line_number})
                        if role == "assistant":
                            assistant_count += 1
                            response_count += 1
                    elif isinstance(kind, str) and kind.endswith("_call"):
                        key = payload.get("call_id") or payload.get("id") or "line-" + str(line_number)
                        standalone = kind in ("web_search_call", "image_generation_call")
                        tools.setdefault(key, {"id": key, "name": payload.get("name") or kind, "input": payload.get("arguments", payload.get("input", payload.get("action", payload))), "output": payload.get("result"), "startedAt": None if standalone else at, "finishedAt": at if standalone and payload.get("status") == "completed" else None, "line": line_number})
                    elif isinstance(kind, str) and kind.endswith("_output"):
                        key = payload.get("call_id")
                        if key in tools:
                            tools[key]["output"] = payload.get("output", payload.get("tools", payload))
                            tools[key]["finishedAt"] = at
                elif row.get("type") == "event_msg" and payload.get("type") == "token_count":
                    info = payload.get("info")
                    totals = numeric_usage(info.get("total_token_usage") if isinstance(info, dict) else None,
                                           ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"))
                    if totals:
                        cumulative.append(totals)
                        last_usage_response = response_count
            else:
                if row.get("isSidechain") and not selected["child"]:
                    continue
                uuid = row.get("uuid")
                row_key = hashlib.sha256(raw).hexdigest()
                if row_key in seen_rows:
                    continue
                seen_rows.add(row_key)
                message = row.get("message")
                if not isinstance(message, dict):
                    continue
                role = message.get("role", row.get("type"))
                message_id = message.get("id") or uuid or "line-" + str(line_number)
                if role in ("user", "assistant"):
                    text = text_blocks(message.get("content"))
                    text_key = (message_id, role, text)
                    if text and text_key not in seen_text:
                        seen_text.add(text_key)
                        conversations.append({"role": role, "text": text, "at": at, "line": line_number})
                    if role == "assistant":
                        assistant_count += 1
                        usage = numeric_usage(message.get("usage"), ("input_tokens", "output_tokens"))
                        if usage:
                            raw_usage = message["usage"]
                            cache_values = [raw_usage.get(key, 0) for key in ("cache_creation_input_tokens", "cache_read_input_tokens")]
                            if all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in cache_values):
                                usage_records[message_id] = usage["input_tokens"] + usage["output_tokens"] + sum(cache_values)
                            else:
                                usage_records[message_id] = None
                        else:
                            usage_records.setdefault(message_id, None)
                content = message.get("content")
                for block in content if isinstance(content, list) else []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use":
                        key = block.get("id") or "line-" + str(line_number)
                        tools.setdefault(key, {"id": key, "name": block.get("name"), "input": block.get("input"), "output": None, "startedAt": at, "finishedAt": None, "line": line_number})
                    elif block.get("type") == "tool_result" and block.get("tool_use_id") in tools:
                        tool = tools[block["tool_use_id"]]
                        tool["output"] = block.get("content")
                        tool["finishedAt"] = at
    if not conversations and not tools:
        problems.append("No supported conversation or tool records in selected history")
    stat = path.stat()
    if [stat.st_size, stat.st_mtime_ns] != selected["signature"]:
        problems.append("Native session changed during snapshot; retry after it is stable")
    if len(conversations) + len(tools) > MAX_EVENTS:
        problems.append("Snapshot event output limit reached")
        conversations = conversations[:MAX_EVENTS]
        tools = dict(list(tools.items())[:max(0, MAX_EVENTS - len(conversations))])
    total, certainty, method = None, "unknown", "Native usage unavailable"
    if args.runtime == "codex" and cumulative:
        reset = any(any(current[key] < previous[key] for key in current) for previous, current in zip(cumulative, cumulative[1:]))
        if selected["forkedFromId"] or reset:
            method = "Forked or reset cumulative counters cannot establish this session's consumption"
        else:
            total = cumulative[-1]["total_tokens"]
            certainty = "exact" if last_usage_response == response_count else "estimated"
            method = "Latest native cumulative total; repeated cumulative samples are not summed"
    elif args.runtime == "claude" and usage_records:
        unknown_usage = sum(value is None for value in usage_records.values())
        known = [value for value in usage_records.values() if value is not None]
        if known:
            total = sum(known)
            certainty = "estimated" if unknown_usage else "exact"
            method = "Per-message native input + output + cache creation/read; streaming message IDs counted once"
    coverage = "Selected native file only; linked child sessions excluded; " + str(len(conversations)) + " conversation records"
    if problems and total is not None:
        certainty = "estimated"
    tool_rows = list(tools.values())
    waits = []
    for tool in tool_rows:
        if tool["startedAt"] and tool["finishedAt"]:
            elapsed = (datetime.fromisoformat(tool["finishedAt"].replace("Z", "+00:00")) - datetime.fromisoformat(tool["startedAt"].replace("Z", "+00:00"))).total_seconds()
            tool["elapsedSeconds"] = elapsed if elapsed >= 0 else None
            if elapsed >= 0:
                waits.append(elapsed)
        else:
            tool["elapsedSeconds"] = None
    result = {
        "identity": {"sourceId": args.source_id, "runtime": args.runtime, "sessionId": args.session_id},
        "nativePath": str(path), "repository": selected["repository"], "startedAt": selected["startedAt"],
        "complete": not problems, "conversations": conversations, "tools": tool_rows,
        "metrics": [metric("native tokens", "tokens", total, certainty, method, coverage),
                    metric("tool calls", "calls", len(tool_rows), "estimated" if problems else "exact", "Native tool call IDs", coverage),
                    metric("observed tool wait", "seconds", sum(waits) if waits else None, "estimated" if waits else "unknown", "Sum of matched call/result timestamp intervals; includes scheduling and transport", str(len(waits)) + "/" + str(len(tool_rows)) + " calls")],
        "coverage": {"problems": problems, "unreadableHeaders": unreadable,
                     "assistantRecords": assistant_count, "usageMessagesMissing": unknown_usage,
                     "linkedChildren": [{"sessionId": row["sessionId"], "nativePath": row["nativePath"]} for row in records if row["parentSessionId"] == args.session_id]},
    }
    if len(json.dumps(result, ensure_ascii=False).encode()) > OUTPUT_BYTES:
        raise ValueError("Snapshot output exceeds bound; inspect the native session manually")
    return result


def writable_target(path):
    path = Path(path)
    if path.exists():
        return path.is_file() and os.access(path, os.W_OK)
    parent = path.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    return parent.is_dir() and os.access(parent, os.W_OK)


def destinations(args):
    at, results = now(), []
    project = Path(args.project).expanduser().resolve() if args.project else None
    repository = canonical_repository("https://" + args.repository) if args.repository else None
    if args.repository and repository != args.repository:
        raise ValueError("--repository must be a canonical Git origin identity")
    if project and not repository:
        raise ValueError("Project destinations require --repository")
    codex_root = Path(args.codex_root or os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    def add(identifier, kind, scope, path, available):
        row = {"id": identifier, "type": kind, "scope": scope, "sourceId": args.source_id,
               "path": str(path), "available": available, "verifiedAt": at}
        if scope == "project":
            row["repository"] = repository
        results.append(row)
    if shutil.which("codex"):
        add("codex-user-instructions", "codex-instructions", "operator", codex_root / "AGENTS.md", writable_target(codex_root / "AGENTS.md"))
        if project:
            add("codex-project-instructions", "codex-instructions", "project", project / "AGENTS.md", writable_target(project / "AGENTS.md"))
    if shutil.which("claude"):
        claude_root = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))).expanduser().resolve()
        add("claude-user-instructions", "instructions", "operator", claude_root / "CLAUDE.md", writable_target(claude_root / "CLAUDE.md"))
        if project:
            add("claude-project-instructions", "instructions", "project", project / "CLAUDE.md", writable_target(project / "CLAUDE.md"))
        if args.claude_memory_path:
            memory = Path(args.claude_memory_path).expanduser()
            if not memory.is_absolute() or not project:
                raise ValueError("Claude memory requires an absolute runtime-confirmed path and project repository")
            add("claude-auto-memory", "claude-memory", "project", memory, memory.is_dir() and os.access(memory, os.R_OK | os.W_OK))
    okf = shutil.which("irudd-okf")
    if okf:
        if args.okf_store:
            add("okf", "okf", "operator", args.okf_store, True)
    return {"sourceId": args.source_id, "verifiedAt": at, "destinations": results,
            "capabilities": {"okfExecutable": okf},
            "notes": ["No native memory setting changed", "Claude auto memory appears only with an explicitly runtime-confirmed directory", "OKF executable detection does not establish a store; inspect its help before proposing a destination"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inventory", "snapshot"):
        command = commands.add_parser(name)
        command.add_argument("--runtime", choices=("codex", "claude"), required=True)
        command.add_argument("--root", required=True, help="Native runtime home, containing sessions/ or projects/")
        command.add_argument("--source-id", required=True)
        if name == "inventory":
            command.add_argument("--tracking", help="Combined Scope tracking pages with audited/agents/mode/cutoff")
            command.add_argument("--current-session")
            command.add_argument("--after")
            command.add_argument("--page-size", type=int, default=200)
        else:
            command.add_argument("--session-id", required=True)
    command = commands.add_parser("destinations")
    command.add_argument("--source-id", required=True)
    command.add_argument("--codex-root")
    command.add_argument("--project")
    command.add_argument("--repository")
    command.add_argument("--okf-store", help="Store location confirmed with the detected OKF CLI; never an inferred path")
    command.add_argument("--claude-memory-path", help="Directory confirmed by the destination Claude runtime's /memory view")
    args = parser.parse_args()
    if args.command == "inventory" and not 1 <= args.page_size <= 200:
        parser.error("--page-size must be between 1 and 200")
    try:
        result = {"inventory": inventory, "snapshot": snapshot, "destinations": destinations}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error), "availability": "unavailable", "inventoryComplete": False}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
