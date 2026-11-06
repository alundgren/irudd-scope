// Render commands.out.json as the proposed Commands table. Usage: node commands-view.mjs <in.json> <out.html>
import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const dur = (ms) =>
  ms >= 3.6e6
    ? `${(ms / 3.6e6).toFixed(1)} h`
    : ms >= 6e4
      ? `${Math.round(ms / 6e4)} min`
      : `${Math.round(ms / 1000)} s`;
const short = (m) =>
  ({
    "claude-opus-5-5": "Opus 5.5",
    "gpt-6.1-sol": "GPT-6.1 Sol",
    "gpt-6-astra": "GPT-6 Astra",
    "grok-4.7-build-fast": "Grok 4.7",
  })[m] || m;
const maxMs = Math.max(...d.rows.map((r) => r.ms));
const other = d.other;
const rows = d.rows
  .slice(0, 15)
  .map((r, i) => {
    const models = Object.entries(r.byModel)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(
        ([m, v]) =>
          `<tr><td>${esc(short(m))}</td><td class="num">${v.n}</td><td class="num">${dur(v.ms)}</td><td class="num">${dur(v.ms / v.n)}</td></tr>`,
      )
      .join("");
    const slow = (r.slowest || [])
      .map(
        ([ms, c]) =>
          `<div class="ex"><span class="num">${dur(ms)}</span> <code>…${esc(c)}</code></div>`,
      )
      .join("");
    return `<tr class="row" data-i="${i}"><td class="tw">▸</td><td><code>${esc(r.key)}</code></td><td class="num">${r.n}</td>
  <td><div class="tot"><span class="b" style="width:${(r.ms / maxMs) * 100}%"></span><span>${dur(r.ms)}</span></div></td>
  <td class="num">${dur(r.ms / r.n)}</td><td class="num">${dur(r.max)}</td>
  <td class="num ${r.failed ? "warn" : "muted"}">${r.failed}</td><td class="num ${r.cold ? "" : "muted"}">${r.cold}</td><td class="num ${r.lock ? "" : "muted"}">${r.lock}</td></tr>
  <tr class="more" id="m${i}" hidden><td></td><td colspan="8"><div class="split"><div><div class="h">By model</div><table class="inner"><tr><th>Model</th><th class="num">Calls</th><th class="num">Total</th><th class="num">Avg</th></tr>${models}</table></div>
  <div><div class="h">Slowest calls (end of command text)</div>${slow}</div></div></td></tr>`;
  })
  .join("");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Commands</title><style>
body{margin:0;font-size:13px;line-height:1.4}
.top{display:flex;flex-wrap:wrap;gap:6px 24px;margin:0 0 12px}.n{font-size:20px;font-weight:600}.l{color:var(--muted-foreground);font-size:12px}
.card{background:var(--card);border-radius:var(--radius);padding:16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th{font-weight:500;color:var(--muted-foreground);text-align:left;font-size:12px;padding:4px 6px;white-space:nowrap}
td{padding:5px 6px;border-top:1px solid var(--border);vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--muted-foreground)}.warn{color:var(--warning)}
code{font-family:var(--font-mono);font-size:12px}.row{cursor:pointer}.row:hover td{background:color-mix(in srgb,var(--muted) 50%,transparent)}.tw{width:12px;color:var(--muted-foreground)}
.tot{position:relative;min-width:120px;height:18px;display:flex;align-items:center}.tot .b{position:absolute;left:0;top:3px;height:12px;border-radius:2px;background:var(--chart-1);opacity:.35}.tot span:last-child{position:relative;padding-left:4px}
.split{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:16px;padding:6px 0}.h{font-size:12px;color:var(--muted-foreground);margin-bottom:4px}
.inner td,.inner th{border:0;padding:2px 6px}.ex{margin:2px 0 6px;word-break:break-all}.ex code{color:var(--muted-foreground)}
.note{color:var(--muted-foreground);font-size:12px;margin-top:10px}
</style></head><body>
<div class="top">
<div><div class="n">${dur(d.total)}</div><div class="l">Shell time (calls can overlap)</div></div>
<div><div class="n">${d.calls.toLocaleString()}</div><div class="l">Shell calls</div></div>
<div><div class="n">${d.groups}</div><div class="l">Command groups</div></div>
<div><div class="n">${((other.ms / d.total) * 100).toFixed(1)}%</div><div class="l">Time not matched ("other", ${other.n} calls)</div></div>
</div>
<div class="card"><table><thead><tr><th></th><th>Command</th><th class="num">Calls</th><th>Total</th><th class="num">Avg</th><th class="num">Max</th><th class="num">Failed</th><th class="num" title="Captured output shows 10+ Compiling lines">Cold builds</th><th class="num" title="Output shows Blocking waiting for file lock">Lock waits</th></tr></thead><tbody>${rows}</tbody></table>
<div class="note">Top 15 of ${d.groups} groups. Click a row for the split by model and its slowest calls. Cold builds and lock waits are read from output clipped to 2 KB at each end, so they are lower bounds.</div></div>
<script>document.querySelectorAll(".row").forEach(r=>r.onclick=()=>{const m=document.getElementById("m"+r.dataset.i);m.hidden=!m.hidden;r.firstElementChild.textContent=m.hidden?"▸":"▾"});document.querySelector(".row").click();</script>
</body></html>`;
fs.writeFileSync(process.argv[3], html);
console.log(html.length);
