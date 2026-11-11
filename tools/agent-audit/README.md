# Agent audit prototype (draft, do not merge)

Read-only scripts that export T3 Code threads, with their child threads and
the Claude and Codex logs behind them, into one self-contained `viewer.html`.
Nothing on the machine is changed. Python 3.8+ with no extra packages.

```
python -I build.py --days 7
python -I build.py --thread <T3 thread id>
```

If the T3 database is not in `~/.t3/userdata`, pass `--t3-dir <folder with
statev2.sqlite>`. Use `--claude-dir` and `--codex-dir` when those logs live
somewhere else, for example inside WSL.

`viewer.html` and `data.json` contain your own session data. Do not commit
them.
