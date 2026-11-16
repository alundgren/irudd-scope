// Render failures.json as the proposed "Failed calls by cause" table. Usage: node failures-view.mjs <in.json> <out.html>
import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const max = Math.max(...d.rows.map((g) => g.n));
const rows = d.rows
  .map((g, i) => {
    const models = Object.entries(g.byModel)
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${esc(m)} ${n}`)
      .join(" · ");
    const ex = g.examples
      .slice(0, 2)
      .map(
        (e) =>
          `<div class="ex"><div class="muted">${esc(e.thread)}</div><code>…${esc(e.input.slice(-110))}</code><div class="out">→ ${esc(e.output.slice(0, 130)) || "<i>no output</i>"}</div></div>`,
      )
      .join("");
    return `<tr class="row" data-i="${i}"><td class="tw">▸</td><td>${esc(g.cause)}</td><td class="num">${g.n}</td>
<td><span class="b" style="width:${(g.n / max) * 140}px"></span></td><td class="muted">${models}</td></tr>
<tr id="d${i}" hidden><td></td><td colspan="4">${ex}</td></tr>`;
  })
  .join("");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Failures</title><style>
body{margin:0;font-size:13px;line-height:1.4}.lead{color:var(--muted-foreground);margin:0 0 10px}
.card{background:var(--card);border-radius:var(--radius);padding:16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th{font-weight:500;color:var(--muted-foreground);text-align:left;font-size:12px;padding:4px 6px}
td{padding:5px 6px;border-top:1px solid var(--border);vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted-foreground);font-size:12px}.row{cursor:pointer}.row:hover td{background:color-mix(in srgb,var(--muted) 50%,transparent)}.tw{width:12px;color:var(--muted-foreground)}
.b{display:inline-block;height:10px;margin-top:4px;border-radius:2px;background:var(--destructive);opacity:.6}
code{font-family:var(--font-mono);font-size:12px;word-break:break-all}.ex{margin:4px 0 10px}.out{font-family:var(--font-mono);font-size:12px;word-break:break-all}
</style></head><body>
<p class="lead">${d.failed} of ${d.total.toLocaleString()} tool calls failed (${((d.failed / d.total) * 100).toFixed(1)}%). Cause is read from each call's output; the first matching rule wins. Click a row for examples.</p>
<div class="card"><table><thead><tr><th></th><th>Cause</th><th class="num">Failed</th><th></th><th>By model</th></tr></thead><tbody>${rows}</tbody></table></div>
<script>document.querySelectorAll(".row").forEach(r=>r.onclick=()=>{const d=document.getElementById("d"+r.dataset.i);d.hidden=!d.hidden;r.firstElementChild.textContent=d.hidden?"▸":"▾"});document.querySelector(".row").click();</script>
</body></html>`;
fs.writeFileSync(process.argv[3], html);
console.log(html.length);
