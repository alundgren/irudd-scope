"""What collect.py would add: each thread's first user message (its instructions)
and last assistant message (its outcome). Read-only.
  py -3 -I messages.py <data.json> <statev2.sqlite> <out.json>
"""
import json, sqlite3, sys

data = json.load(open(sys.argv[1], encoding='utf-8'))
db = sqlite3.connect(f'file:{sys.argv[2]}?mode=ro', uri=True)
out = {}
for t in data['threads']:
    rows = db.execute(
        'select role, payload_json from orchestration_v2_projection_messages '
        'where thread_id = ? and streaming = 0 order by created_at', (t['id'],)).fetchall()
    texts = [(role, json.loads(p).get('text') or '') for role, p in rows]
    user = [x for r, x in texts if r == 'user' and x.strip()]
    asst = [x for r, x in texts if r == 'assistant' and x.strip()]
    out[t['id']] = {'instructions': user[0] if user else '', 'outcome': asst[-1] if asst else ''}
json.dump(out, open(sys.argv[3], 'w', encoding='utf-8'))
print(len(out), 'threads,', sum(1 for v in out.values() if v['instructions']), 'with instructions,',
      sum(1 for v in out.values() if v['outcome']), 'with an outcome')
