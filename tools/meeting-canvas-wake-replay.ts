/**
 * A self-contained player for one wake-word bench run: the canvas as it was after each
 * request, scaled to fit, with the transcript underneath. Wake chunks are highlighted,
 * and a status line shows what was heard and when the canvas changed.
 */
import type { Canvas } from "../apps/desktop/src/plugins/meeting/contract.ts";

type Result = {
  chunks: { line: number; speaker: string; text: string; start: number; end: number }[];
  requests: {
    action: string;
    text: string;
    lines: number[];
    sentAt: number;
    doneAt: number;
    ms?: number;
    changed?: string[];
    rejected?: unknown[];
    canvas: Canvas;
    error?: string;
  }[];
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function scriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function wakeReplayHtml(input: {
  title: string;
  css: string;
  result: Result;
  /** Renders a canvas to escaped HTML; model text never reaches the page unescaped. */
  render: (canvas: Canvas) => string;
}) {
  const { chunks, requests } = input.result;
  const wake = new Set(requests.flatMap((request) => request.lines));
  const data = {
    end: Math.max(chunks.at(-1)?.end ?? 0, ...requests.map((request) => request.doneAt)) + 3,
    chunks: chunks.map((chunk) => ({ ...chunk, wake: wake.has(chunk.line) })),
    requests: requests.map((request) => ({
      action: request.action,
      text: request.text,
      heardAt: Math.max(
        ...request.lines.map((line) => chunks.find((chunk) => chunk.line === line)?.end ?? 0),
      ),
      sentAt: request.sentAt,
      doneAt: request.doneAt,
      ms: request.ms ?? null,
      changed: request.changed ?? [],
      rejected: request.rejected?.length ?? 0,
      error: request.error ?? null,
      html: input.render(request.canvas),
    })),
  };
  const title = escapeHtml(input.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
${input.css}
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.rp { display: grid; grid-template-rows: auto auto 1fr minmax(170px, 30vh); height: 100vh; }
.rp-bar { display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid light-dark(#e3e5ea, #2c2f36); }
.rp-bar strong { margin-right: auto; font-weight: 650; }
.rp-bar button, .rp-bar select { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid light-dark(#d4d7de, #3a3e46); background: transparent; color: inherit; }
.rp-bar input[type=range] { width: 260px; }
.rp-time { color: light-dark(#5b606b, #a3a8b3); font-variant-numeric: tabular-nums; }
.rp-status { padding: 6px 14px; min-height: 1.5em; background: light-dark(#f2f6fd, #17202d); color: light-dark(#1c4f99, #8fb6ee); font-size: 13px; }
.rp-status.is-error { background: light-dark(#fdf1f1, #2d1717); color: light-dark(#a12020, #f08f8f); }
.rp-stage { position: relative; overflow: auto; }
.rp-scale { transform-origin: 0 0; }
.rp-transcript { overflow: auto; padding: 10px 18px; border-top: 1px solid light-dark(#e3e5ea, #2c2f36); background: light-dark(#f7f8fa, #16181c); }
.rp-line { margin: 1px 0; }
.rp-line.is-future { opacity: 0.25; }
.rp-line.is-wake { background: light-dark(#fff4d6, #3a3017); border-radius: 4px; }
.rp-line b { font-weight: 600; color: light-dark(#5b606b, #a3a8b3); }
.rp-at { display: inline-block; width: 4.2em; color: light-dark(#8a8f99, #7c818b); font-variant-numeric: tabular-nums; }
.rp-flash { outline: 3px solid light-dark(#1c65c8, #4885df); outline-offset: 4px; transition: outline-color 1.6s; }
</style>
</head>
<body>
<div class="rp">
  <div class="rp-bar">
    <strong>${title}</strong>
    <button id="play" type="button">Play</button>
    <button id="prev" type="button" title="Previous request">◀</button>
    <button id="next" type="button" title="Next request">▶</button>
    <select id="speed" aria-label="Speed"><option value="1">1×</option><option value="2" selected>2×</option><option value="4">4×</option><option value="8">8×</option></select>
    <input id="scrub" type="range" min="0" step="0.1" aria-label="Time">
    <span id="time" class="rp-time"></span>
  </div>
  <div id="status" class="rp-status" role="status"></div>
  <div id="stage" class="rp-stage"><div id="scale" class="rp-scale"><main id="canvas" class="mc-page"></main></div></div>
  <div id="transcript" class="rp-transcript" aria-label="Transcript"></div>
</div>
<script type="application/json" id="replay-data">${scriptJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById("replay-data").textContent);
const $ = (id) => document.getElementById(id);
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
$("scrub").max = String(data.end);
const rows = data.chunks.map((chunk) => {
  const row = document.createElement("div");
  row.className = "rp-line" + (chunk.wake ? " is-wake" : "");
  const at = document.createElement("span");
  at.className = "rp-at";
  at.textContent = fmt(chunk.end);
  const who = document.createElement("b");
  who.textContent = chunk.speaker ? chunk.speaker + ": " : "";
  row.append(at, who, document.createTextNode(chunk.text));
  $("transcript").append(row);
  return row;
});
let time = 0, shown = -2, playing = false, last = 0;
function fit() {
  const inner = $("canvas").firstElementChild;
  const width = inner ? inner.scrollWidth : 1;
  const scale = Math.min(1, ($("stage").clientWidth - 24) / Math.max(1, width));
  $("scale").style.transform = "scale(" + scale + ")";
  $("scale").style.width = (100 / scale) + "%";
}
function render() {
  let step = -1;
  data.requests.forEach((request, index) => { if (request.doneAt <= time) step = index; });
  if (step !== shown) {
    let html = '<div class="mc-page-inner"><p>Nothing drawn yet. Say “Canvas, …” to ask for something.</p></div>';
    for (let i = step; i >= 0; i--) if (data.requests[i].html) { html = data.requests[i].html; break; }
    $("canvas").innerHTML = html;
    fit();
    if (step >= 0 && step === shown + 1) {
      for (const id of data.requests[step].changed) {
        const section = $("canvas").querySelector('[data-section="' + CSS.escape(id) + '"]');
        if (section) { section.classList.add("rp-flash"); section.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); setTimeout(() => section.classList.remove("rp-flash"), 1600); }
      }
    }
    shown = step;
  }
  let status = "", error = false;
  for (const request of data.requests) {
    if (request.heardAt > time) break;
    if (time < request.doneAt) { status = (time < request.sentAt ? "Heard: “" : "Working on: “") + request.text + "”"; error = false; }
    else if (time < request.doneAt + 4) {
      if (request.error) { status = "Failed: " + request.error; error = true; }
      else if (request.action !== "model") { status = (request.action === "undo" ? "Undone" : "Cancelled") + ": “" + request.text + "”"; error = false; }
      else { status = (request.changed.length ? "Done" : "Ignored") + " in " + ((request.ms ?? 0) / 1000).toFixed(1) + " s: “" + request.text + "”" + (request.rejected ? " (" + request.rejected + " ops rejected)" : ""); error = false; }
    }
  }
  $("status").textContent = status;
  $("status").classList.toggle("is-error", error);
  let current = null;
  rows.forEach((row, index) => { const heard = data.chunks[index].end <= time; row.classList.toggle("is-future", !heard); if (heard) current = row; });
  if (current && playing) current.scrollIntoView({ block: "nearest" });
  $("time").textContent = fmt(time) + " / " + fmt(data.end) + " · " + (step + 1) + " of " + data.requests.length + " requests";
  $("scrub").value = String(time);
}
function tick(now) {
  if (!playing) return;
  time = Math.min(data.end, time + ((now - last) / 1000) * Number($("speed").value));
  last = now;
  render();
  if (time >= data.end) { playing = false; $("play").textContent = "Play"; return; }
  requestAnimationFrame(tick);
}
$("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "Pause" : "Play"; if (playing) { if (time >= data.end) time = 0; last = performance.now(); requestAnimationFrame(tick); } };
$("scrub").oninput = () => { time = Number($("scrub").value); render(); };
$("next").onclick = () => { const at = data.requests.map((r) => r.doneAt).find((v) => v > time + 0.01); time = at ?? data.end; render(); };
$("prev").onclick = () => { const earlier = data.requests.map((r) => r.doneAt).filter((v) => v < time - 0.01); time = earlier.length > 1 ? earlier[earlier.length - 2] : 0; render(); };
addEventListener("resize", fit);
render();
</script>
</body>
</html>
`;
}
