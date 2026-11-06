// Build a standalone page with a working search box over child threads' instructions and outcomes.
// Usage: node search-live.mjs <data.json> <messages.json> <out.html>
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const msgs = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const rows = data.threads
  .filter((t) => t.parentId === data.focusThread && t.runs.length)
  .sort((a, b) => (a.runs[0].startedAt < b.runs[0].startedAt ? -1 : 1))
  .map((t) => ({
    title: t.title,
    start: t.runs[0].startedAt,
    model: t.runs[0].model,
    ...(msgs[t.id] || {}),
  }));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search child threads</title><style>
:root{color-scheme:light dark;--bg:#fcfcfb;--fg:#0b0b0b;--muted:#5d5c58;--line:#e2e0da;--mark:#f6d58a}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--muted:#a9a89f;--line:#2f2f2c;--mark:#7a5a12}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px}
h1{font-size:18px;margin:0 0 4px}.lead{color:var(--muted);margin:0 0 16px}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
input[type=search]{flex:1;min-width:280px;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
label{color:var(--muted);white-space:nowrap}.count{color:var(--muted);margin:8px 0 12px}
.hit{border-top:1px solid var(--line);padding:10px 0}.t{font-weight:600}.meta{color:var(--muted);font-size:12px}
.s{color:var(--muted);margin-top:4px;white-space:pre-wrap;word-break:break-word}.s b{font-weight:500;color:var(--fg)}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:12px}pre{white-space:pre-wrap;font:12px/1.45 ui-monospace,Consolas,monospace;margin:6px 0 0}
</style></head><body><main>
<h1>${data.threads.find((t) => t.id === data.focusThread).title.replace(/</g, "&lt;")}</h1>
<p class="lead">Search what each of the ${rows.length} child threads was told, and what it reported back.</p>
<div class="bar"><input type="search" id="q" placeholder="Type a word or phrase, e.g. cargo xtask check" autofocus>
<label><input type="radio" name="f" value="instructions" checked> What it was told</label>
<label><input type="radio" name="f" value="outcome"> What it reported</label>
<label><input type="radio" name="f" value="both"> Both</label></div>
<div class="count" id="count"></div><div id="list"></div>
<script>
const ROWS = ${JSON.stringify(rows).replace(/</g, "\\u003c")};
const esc = s => s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]);
const q = document.getElementById("q"), list = document.getElementById("list"), count = document.getElementById("count");
function field() { return document.querySelector("input[name=f]:checked").value; }
function snippet(text, needle) {
  const i = text.toLowerCase().indexOf(needle);
  const a = Math.max(0, i - 120), b = Math.min(text.length, i + needle.length + 120);
  return (a ? "…" : "") + esc(text.slice(a, i)) + "<mark>" + esc(text.slice(i, i + needle.length)) + "</mark>" + esc(text.slice(i + needle.length, b)) + (b < text.length ? "…" : "");
}
function render() {
  const needle = q.value.trim().toLowerCase(), f = field();
  const fields = f === "both" ? ["instructions", "outcome"] : [f];
  const hits = needle ? ROWS.filter(r => fields.some(k => (r[k] || "").toLowerCase().includes(needle))) : ROWS;
  count.textContent = needle ? hits.length + " of " + ROWS.length + " threads match" : ROWS.length + " threads. Type to search.";
  list.innerHTML = hits.map(r => {
    const where = fields.filter(k => needle && (r[k] || "").toLowerCase().includes(needle));
    const snips = where.map(k => '<div class="s"><b>' + (k === "instructions" ? "Told: " : "Reported: ") + "</b>" + snippet(r[k], needle) + "</div>").join("");
    return '<div class="hit"><div class="t">' + esc(r.title) + '</div><div class="meta">' + new Date(r.start).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) + " · " + esc(r.model || "") + "</div>" + snips +
      '<details><summary>Full instructions and report</summary><pre><b>Told:</b>\\n' + esc(r.instructions || "") + '\\n\\n<b>Reported:</b>\\n' + esc(r.outcome || "") + "</pre></details></div>";
  }).join("");
}
q.oninput = render; document.querySelectorAll("input[name=f]").forEach(e => e.onchange = render); render();
</script></main></body></html>`;
fs.writeFileSync(
  process.argv[4] || process.argv[3].replace(/messages\.json$/, "search-live.html"),
  html,
);
console.log(rows.length, "threads,", Math.round(html.length / 1024), "KB");
