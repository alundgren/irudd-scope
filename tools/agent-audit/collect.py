"""Read T3 Code history and harness logs on this machine.

Read-only. Writes one JSON file with facts only: no grouping, no diagnosis.
  python collect.py --days 3
  python collect.py --thread <T3 thread id>     (that thread and all its child threads, any age)
Runs on Linux, macOS and Windows with Python 3.8+ and no extra packages.
"""
import argparse, glob, json, os, re, socket, sqlite3, sys, time
from datetime import datetime, timezone
from pathlib import Path

HOME = os.path.expanduser('~')
ap = argparse.ArgumentParser()
ap.add_argument('--days', type=float, default=3)
ap.add_argument('--thread')
ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json'))
ap.add_argument('--t3-dir', default=os.path.join(HOME, '.t3', 'userdata'))
ap.add_argument('--claude-dir', default=os.path.join(HOME, '.claude'))
ap.add_argument('--codex-dir', default=os.path.join(HOME, '.codex'))
args = ap.parse_args()
DAYS = None if args.thread else args.days
OUT = args.out
T3_DB = os.path.join(args.t3_dir, 'statev2.sqlite')
RATES = os.path.join(args.t3_dir, 'usage-model-rates.json')
if not os.path.exists(T3_DB):
    sys.exit(f'T3 database not found at {T3_DB}. Pass --t3-dir with the folder that holds statev2.sqlite.')
CUT_S = 0 if args.thread else time.time() - DAYS * 86400
CUT_ISO = '' if args.thread else datetime.fromtimestamp(CUT_S, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
KEEP = 2048
TOOL_TYPES = ('command_execution', 'dynamic_tool', 'file_change', 'file_search', 'web_search')
EVENT_TYPES = ('compaction', 'approval_request', 'user_input_request', 'run_interrupt_request', 'error')

SECRET = re.compile(r'(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})')
# Long random-looking runs: keys and base64 blobs mix upper case, lower case and digits. File names and ids rarely do.
BLOB = re.compile(r'[A-Za-z0-9+/=]{40,}')


def _blob(m):
    v = m.group(0)
    mixed = re.search(r'[A-Z]', v) and re.search(r'[a-z]', v) and re.search(r'[0-9]', v) and '/' not in v.strip('/')[:1]
    return '[hidden]' if mixed and not re.fullmatch(r'[a-z0-9/]+', v) else v


def clean(s):
    return BLOB.sub(_blob, SECRET.sub('[hidden]', s))


def text(v):
    if v is None:
        return ''
    if isinstance(v, str):
        return v
    if isinstance(v, list) and all(isinstance(x, dict) for x in v):
        parts = [x.get('text') if isinstance(x.get('text'), str) else json.dumps(x) for x in v]
        return '\n'.join(parts)
    return json.dumps(v)


def output_fields(v):
    s = text(v)
    if len(s) <= 2 * KEEP:
        return {'outChars': len(s), 'outHead': clean(s), 'outTail': ''}
    return {'outChars': len(s), 'outHead': clean(s[:KEEP]), 'outTail': clean(s[-KEEP:])}


def ms(a, b):
    try:
        x = datetime.fromisoformat(a.replace('Z', '+00:00'))
        y = datetime.fromisoformat(b.replace('Z', '+00:00'))
        return int((y - x).total_seconds() * 1000)
    except Exception:
        return None


# ---- prices -------------------------------------------------------------
_rates = json.load(open(RATES, encoding='utf-8'))['document'] if os.path.exists(RATES) else {}


def rate(model):
    if not model:
        return None
    r = _rates.get(model) or _rates.get(model.split('[')[0])
    if not r:
        return None
    return dict(inp=r.get('input_cost_per_token') or 0,
                read=r.get('cache_read_input_token_cost') or 0,
                w5=r.get('cache_creation_input_token_cost') or 0,
                w1=r.get('cache_creation_input_token_cost_above_1hr') or r.get('cache_creation_input_token_cost') or 0,
                out=r.get('output_cost_per_token') or 0)


def cost(model, t):
    r = rate(model)
    if not r:
        return None
    return round(t.get('uncached', 0) * r['inp'] + t.get('cacheRead', 0) * r['read']
                 + t.get('cacheWrite5m', 0) * r['w5'] + t.get('cacheWrite1h', 0) * r['w1']
                 + t.get('output', 0) * r['out'], 4)


# ---- T3 -----------------------------------------------------------------
db = sqlite3.connect(Path(T3_DB).resolve().as_uri() + '?mode=ro', uri=True)
q = lambda sql, *a: db.execute(sql, a).fetchall()

# Thread mode: the named thread and every thread below it, whatever their age.
ONLY = None
if args.thread:
    ONLY = {args.thread}
    frontier = [args.thread]
    while frontier:
        kids = [c for (c,) in q(f'select child_thread_id from orchestration_v2_projection_subagents where thread_id in ({",".join("?" * len(frontier))}) and child_thread_id is not null', *frontier)]
        frontier = [k for k in kids if k not in ONLY]
        ONLY.update(frontier)
    if not q('select 1 from orchestration_v2_projection_threads where thread_id = ?', args.thread):
        sys.exit(f'Thread {args.thread} is not in {T3_DB}.')


def scope(time_cols, table_alias=''):
    """SQL filter and parameters: by thread list in thread mode, by time otherwise."""
    if ONLY is not None:
        return f'{table_alias}thread_id in ({",".join("?" * len(ONLY))})', list(ONLY)
    return '(' + ' or '.join(f'{c} >= ?' if c != 'open' else 'completed_at is null' for c in time_cols) + ')', [CUT_ISO] * sum(c != 'open' for c in time_cols)


projects = dict(q('select project_id, title from projection_projects'))
threads = {}
w, a = scope(['updated_at'])
for tid, pid, title, created, updated, pj in q(
        'select thread_id, project_id, title, created_at, updated_at, payload_json '
        f'from orchestration_v2_projection_threads where {w} and deleted_at is null', *a):
    p = json.loads(pj)
    threads[tid] = dict(id=tid, title=title, project=projects.get(pid, pid), createdAt=created, updatedAt=updated,
                        branch=p.get('branch'), parentId=None, origin=None, runs=[], items=[], events={}, logs=[])

w, a = scope(['updated_at'])
for parent, child, origin, prov, pj in q(
        'select thread_id, child_thread_id, origin, provider, payload_json from orchestration_v2_projection_subagents '
        f'where {w}', *a):
    if child in threads:
        threads[child]['parentId'] = parent
        threads[child]['origin'] = origin

runs = {}
for rid, tid, ordn, prov, status, req, done, pj in q(
        'select run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json '
        'from orchestration_v2_projection_runs where ' + scope(['requested_at', 'completed_at', 'open'])[0],
        *scope(['requested_at', 'completed_at', 'open'])[1]):
    if tid not in threads:
        continue
    p = json.loads(pj)
    sel = p.get('modelSelection') or {}
    opts = {o.get('id'): o.get('value') for o in sel.get('options') or []}
    run = dict(ordinal=ordn, provider=prov, model=sel.get('model'), effort=opts.get('effort') or opts.get('reasoningEffort'),
               fast=bool(opts.get('fastMode')) or opts.get('serviceTier') == 'priority',
               status=status, requestedAt=req, startedAt=p.get('startedAt'), completedAt=done, turns=[], items=[])
    runs[rid] = run
    threads[tid]['runs'].append(run)

attempt_run = dict(q('select attempt_id, run_id from orchestration_v2_projection_run_attempts'))
turns = {}
for ptid, tid, att, status, start, end, pj in q(
        'select provider_turn_id, thread_id, run_attempt_id, status, started_at, completed_at, payload_json '
        'from orchestration_v2_projection_provider_turns where ' + scope(['started_at', 'completed_at', 'open'])[0],
        *scope(['started_at', 'completed_at', 'open'])[1]):
    run = runs.get(attempt_run.get(att))
    if not run:
        continue
    p = json.loads(pj)
    u = p.get('turnTokenUsage') or {}
    c = p.get('tokenUsage') or {}
    tok = None
    if u:
        inp, read, write = u.get('inputTokens', 0), u.get('cachedInputTokens', 0), u.get('cacheCreationTokens', 0)
        # T3 does not split Claude cache writes; Claude Code writes the 1-hour cache.
        w1 = write if run['provider'] == 'claudeAgent' else 0
        tok = dict(uncached=max(inp - read - write, 0), cacheRead=read, cacheWrite5m=write - w1, cacheWrite1h=w1,
                   output=u.get('outputTokens', 0), reasoning=u.get('reasoningTokens', 0),
                   complete=u.get('usageStatus') == 'complete', scope=u.get('usageScope'))
    turn = dict(id=ptid, status=status, start=start, end=end, durMs=ms(start, end) if end else None,
                tokens=tok, cost=cost(run['model'], tok) if tok else None,
                contextUsed=c.get('usedTokens'), contextMax=c.get('maxTokens'), items=[])
    turns[ptid] = turn
    run['turns'].append(turn)

for tid, ptid, rid, ordn, ty, status, pj in q(
        'select thread_id, provider_turn_id, run_id, ordinal, type, status, payload_json from orchestration_v2_projection_turn_items '
        f'where {scope(["updated_at"])[0]} and type in ({",".join("?" * len(TOOL_TYPES + EVENT_TYPES))}) order by ordinal',
        *scope(['updated_at'])[1], *TOOL_TYPES, *EVENT_TYPES):
    if tid not in threads:
        continue
    if ty in EVENT_TYPES:
        threads[tid]['events'][ty] = threads[tid]['events'].get(ty, 0) + 1
        continue
    # Provider-native subagent items have no T3 turn, and some have no run either.
    owner = turns.get(ptid) or runs.get(rid) or threads[tid]
    p = json.loads(pj)
    name = {'command_execution': 'shell'}.get(ty) or p.get('toolName') or ty
    name = re.sub(r'^mcp__(.+?)__', r'\1.', name)
    s, e = p.get('startedAt'), p.get('completedAt')
    item = dict(kind=ty, name=name, input=clean(text(p.get('input')))[:400], status=status, exit=p.get('exitCode'),
                start=s, durMs=ms(s, e) if s and e else None)
    item.update(output_fields(p.get('output')))
    owner.setdefault('items', []).append(item)

native = {}
w, a = scope(['updated_at'])
for tid, prov, pj in q(f'select thread_id, provider, payload_json from orchestration_v2_projection_provider_threads where {w}', *a):
    ref = (json.loads(pj).get('nativeThreadRef') or {}).get('nativeId')
    if ref and tid in threads:
        native[ref] = tid


# ---- harness logs -------------------------------------------------------
def empty_tokens():
    return dict(uncached=0, cacheRead=0, cacheWrite5m=0, cacheWrite1h=0, output=0, reasoning=0)


def add(a, b):
    for k in a:
        a[k] += b.get(k, 0)


def claude_log(path):
    parts = path.replace('\\', '/').split('/')
    sub = 'subagents' in parts[-2:-1]
    session = parts[-3] if sub else os.path.basename(path)[:-6]
    log = dict(harness='claude', path=path.replace(HOME, '~'), session=session,
               agent=os.path.basename(path)[6:-6] if sub else None, kind='subagent' if sub else 'session',
               threadId=native.get(session), models={}, apiCalls=0, start=None, end=None, toolCalls=[])
    seen, pending = set(), {}
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        ts = d.get('timestamp')
        if ts:
            log['start'] = log['start'] or ts
            log['end'] = ts
        m = d.get('message') if isinstance(d.get('message'), dict) else {}
        if d.get('type') == 'assistant':
            mid = m.get('id')
            if mid and mid not in seen and m.get('usage'):
                seen.add(mid)
                u = m['usage']
                cc = u.get('cache_creation') or {}
                w1 = cc.get('ephemeral_1h_input_tokens', 0)
                w5 = cc.get('ephemeral_5m_input_tokens', u.get('cache_creation_input_tokens', 0) - w1)
                t = dict(uncached=u.get('input_tokens', 0), cacheRead=u.get('cache_read_input_tokens', 0),
                         cacheWrite5m=w5, cacheWrite1h=w1, output=u.get('output_tokens', 0),
                         reasoning=(u.get('output_tokens_details') or {}).get('thinking_tokens', 0))
                mm = log['models'].setdefault(m.get('model') or '?', dict(calls=0, tokens=empty_tokens()))
                mm['calls'] += 1
                add(mm['tokens'], t)
                log['apiCalls'] += 1
            for b in m.get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    pending[b.get('id')] = (b.get('name'), ts, b.get('input'))
        elif d.get('type') == 'user' and isinstance(m.get('content'), list):
            for b in m['content']:
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('tool_use_id') in pending:
                    name, s, inp = pending.pop(b['tool_use_id'])
                    item = dict(kind='tool', name=re.sub(r'^mcp__(.+?)__', r'\1.', name or '?'),
                                input=clean(text(inp))[:400], status='failed' if b.get('is_error') else 'completed',
                                exit=None, start=s, durMs=ms(s, ts) if s and ts else None)
                    item.update(output_fields(b.get('content')))
                    log['toolCalls'].append(item)
    for mm in log['models'].values():
        mm['cost'] = None
    for name, mm in log['models'].items():
        mm['cost'] = cost(name, mm['tokens'])
    return log


def codex_log(path):
    sid = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$', path)
    sid = sid.group(1) if sid else os.path.basename(path)
    log = dict(harness='codex', path=path.replace(HOME, '~'), session=sid, agent=None, kind='session',
               threadId=native.get(sid), models={}, apiCalls=0, start=None, end=None, toolCalls=[], parentSession=None)
    seen, pending, model = set(), {}, None
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        ts = d.get('timestamp')
        if ts:
            log['start'] = log['start'] or ts
            log['end'] = ts
        p = d.get('payload') if isinstance(d.get('payload'), dict) else {}
        ty, pt = d.get('type'), p.get('type')
        if ty == 'session_meta':
            src = p.get('source')
            if isinstance(src, dict):
                log['kind'] = 'subagent'
        elif ty == 'turn_context':
            model = p.get('model')
        elif ty == 'token_usage_record':
            rid = p.get('response_id')
            if rid in seen:
                continue
            seen.add(rid)
            u = p.get('usage') or {}
            inp, read, write = u.get('input_tokens', 0), u.get('cached_input_tokens', 0), u.get('cache_write_input_tokens', 0)
            t = dict(uncached=max(inp - read - write, 0), cacheRead=read, cacheWrite5m=write, cacheWrite1h=0,
                     output=u.get('output_tokens', 0), reasoning=u.get('reasoning_output_tokens', 0))
            mm = log['models'].setdefault(model or '?', dict(calls=0, tokens=empty_tokens()))
            mm['calls'] += 1
            add(mm['tokens'], t)
            log['apiCalls'] += 1
        elif ty == 'response_item' and pt in ('function_call', 'custom_tool_call'):
            pending[p.get('call_id')] = (p.get('name'), ts, p.get('arguments') or p.get('input'))
        elif ty == 'response_item' and pt in ('function_call_output', 'custom_tool_call_output') and p.get('call_id') in pending:
            name, s, inp = pending.pop(p['call_id'])
            item = dict(kind='tool', name=name or '?', input=clean(text(inp))[:400], status='completed', exit=None,
                        start=s, durMs=ms(s, ts) if s and ts else None)
            item.update(output_fields(p.get('output')))
            log['toolCalls'].append(item)
    for name, mm in log['models'].items():
        mm['cost'] = cost(name, mm['tokens'])
    return log


logs = []
CLAUDE = os.path.join(args.claude_dir, 'projects')
CODEX = os.path.join(args.codex_dir, 'sessions')
if ONLY is None:
    claude_paths = glob.glob(os.path.join(CLAUDE, '**', '*.jsonl'), recursive=True)
    codex_paths = glob.glob(os.path.join(CODEX, '**', '*.jsonl'), recursive=True)
else:
    # Only the log files named after this thread tree's native session ids.
    claude_paths, codex_paths = [], []
    for sid in native:
        claude_paths += glob.glob(os.path.join(CLAUDE, '*', glob.escape(sid) + '.jsonl'))
        claude_paths += glob.glob(os.path.join(CLAUDE, '*', glob.escape(sid), 'subagents', '*.jsonl'))
    wanted = set(native)
    for path in glob.glob(os.path.join(CODEX, '**', 'rollout-*.jsonl'), recursive=True):
        if path[-42:-6] in wanted:
            codex_paths.append(path)
for path in claude_paths:
    if os.path.getmtime(path) >= CUT_S:
        logs.append(claude_log(path))
for path in codex_paths:
    if os.path.getmtime(path) >= CUT_S:
        logs.append(codex_log(path))

def all_items(th):
    yield from th['items']
    for r in th['runs']:
        yield from r['items']
        for t in r['turns']:
            yield from t['items']


# T3 names a Claude-native child thread '...:<agentId>'. Without one, fall back to the parent session's thread.
by_agent = {t.rsplit('%3A', 1)[-1].rsplit(':', 1)[-1]: t for t in threads if t.startswith('thread:provider:')}
for log in logs:
    linked_child = False
    if log['kind'] == 'subagent' and log['harness'] == 'claude':
        child = by_agent.get(log['agent'])
        linked_child = bool(child)
        log['threadId'] = child or native.get(log['session'])
    if log['threadId'] in threads:
        threads[log['threadId']]['logs'].append(log['path'])
    # Keep only a count when T3 has this thread's tool calls. T3 has none for some Claude subagents.
    t3_count = sum(1 for _ in all_items(threads[log['threadId']])) if log['threadId'] in threads else 0
    if log['threadId'] and (log['kind'] == 'session' or linked_child or log['harness'] == 'codex') and t3_count > 0:
        log['toolCallCount'] = len(log['toolCalls'])
        log['t3ToolCallCount'] = t3_count
        log['toolCalls'] = []

data = dict(machine=socket.gethostname(), generatedAt=datetime.now(timezone.utc).isoformat(timespec='seconds'),
            windowDays=DAYS, since=CUT_ISO, focusThread=args.thread, threads=list(threads.values()), logs=logs)
json.dump(data, open(OUT, 'w', encoding='utf-8'))
n_items = sum(len(th['items']) + sum(len(r['items']) + sum(len(t['items']) for t in r['turns']) for r in th['runs'])
              for th in threads.values())
print(f'{len(threads)} threads, {len(runs)} runs, {len(turns)} turns, {n_items} T3 tool calls, '
      f'{len(logs)} log files ({sum(len(l["toolCalls"]) for l in logs)} extra tool calls) -> {OUT} '
      f'({os.path.getsize(OUT) // 1024} KB)')
