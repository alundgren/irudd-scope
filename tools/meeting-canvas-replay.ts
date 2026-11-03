/**
 * Builds a self-contained HTML player for one bench run. It replays the transcript at
 * speaking pace and shows the page as it was after each edit call, at the moment that
 * call would have finished, with the transcript underneath.
 */

/** Average speaking pace used to time transcript lines, in words per second. */
const WORDS_PER_SECOND = 2.5;

export type ReplayStep = {
  /** Transcript lines sent in this call. */
  fresh: readonly string[];
  /** Canvas HTML after this call, from renderCanvas, so model text is already escaped. */
  pageHtml: string;
  changed: readonly string[];
  ms?: number;
  applied?: number;
  rejected?: number;
  error?: string;
};

function scriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Times every line and call. A batch's call starts when its last line has been spoken
 * and the previous call has finished, as the app sends one edit at a time. The bench
 * does not merge lines heard during a call into the next batch, so busy stretches run
 * slightly behind the app.
 */
function timeline(steps: readonly ReplayStep[]) {
  let clock = 0;
  let busyUntil = 0;
  const lines: { text: string; at: number; step: number }[] = [];
  const updates: number[] = [];
  steps.forEach((step, index) => {
    for (const text of step.fresh) {
      clock += Math.max(1, text.split(/\s+/).length / WORDS_PER_SECOND);
      lines.push({ text, at: clock, step: index });
    }
    const start = Math.max(clock, busyUntil);
    busyUntil = start + (step.ms ?? 0) / 1000;
    updates.push(busyUntil);
  });
  return { lines, updates, end: Math.max(clock, busyUntil) + 2 };
}

export function replayHtml(input: {
  title: string;
  target: string;
  css: string;
  steps: readonly ReplayStep[];
}) {
  const { lines, updates, end } = timeline(input.steps);
  const data = {
    lines,
    updates,
    end,
    steps: input.steps.map((step) => ({
      html: step.pageHtml,
      changed: step.changed,
      ms: step.ms ?? null,
      applied: step.applied ?? 0,
      rejected: step.rejected ?? 0,
      error: step.error ?? null,
    })),
  };
  const title = escapeHtml(`${input.title} · ${input.target}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
${input.css}
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.rp { display: grid; grid-template-rows: auto 1fr minmax(160px, 30vh); height: 100vh; }
.rp-bar { display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid light-dark(#e3e5ea, #2c2f36); }
.rp-bar strong { margin-right: auto; font-weight: 650; }
.rp-bar button, .rp-bar select { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid light-dark(#d4d7de, #3a3e46); background: transparent; color: inherit; }
.rp-bar input[type=range] { width: 260px; }
.rp-status { color: light-dark(#5b606b, #a3a8b3); font-variant-numeric: tabular-nums; min-width: 20em; }
.rp-page { overflow: auto; }
.rp-transcript { overflow: auto; padding: 10px 18px; border-top: 1px solid light-dark(#e3e5ea, #2c2f36); background: light-dark(#f7f8fa, #16181c); }
.rp-line { margin: 2px 0; color: light-dark(#15171c, #eef0f4); }
.rp-line.is-future { opacity: 0.28; }
.rp-line.is-pending { border-left: 3px solid light-dark(#1c65c8, #4885df); padding-left: 8px; }
.rp-line .rp-at { display: inline-block; width: 4.5em; color: light-dark(#8a8f99, #7c818b); font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="rp">
  <div class="rp-bar">
    <strong>${title}</strong>
    <button id="play" type="button">Play</button>
    <button id="prev" type="button" title="Previous canvas update">◀</button>
    <button id="next" type="button" title="Next canvas update">▶</button>
    <select id="speed" aria-label="Speed"><option value="1">1×</option><option value="2" selected>2×</option><option value="4">4×</option><option value="8">8×</option></select>
    <input id="scrub" type="range" min="0" step="0.1" aria-label="Time">
    <span id="status" class="rp-status"></span>
  </div>
  <div class="rp-page"><main id="page" class="mc-page mc-canvas"></main></div>
  <div id="transcript" class="rp-transcript" aria-label="Transcript"></div>
</div>
<script type="application/json" id="replay-data">${scriptJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById("replay-data").textContent);
const page = document.getElementById("page");
const transcript = document.getElementById("transcript");
const status = document.getElementById("status");
const scrub = document.getElementById("scrub");
const play = document.getElementById("play");
const speed = document.getElementById("speed");
scrub.max = String(data.end);
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const rows = data.lines.map((line) => {
  const row = document.createElement("div");
  row.className = "rp-line";
  const at = document.createElement("span");
  at.className = "rp-at";
  at.textContent = fmt(line.at);
  row.append(at, document.createTextNode(line.text));
  transcript.append(row);
  return row;
});
let time = 0, shown = -2, playing = false, last = 0;
function render() {
  let step = -1;
  data.updates.forEach((at, index) => { if (at <= time) step = index; });
  if (step !== shown) {
    page.innerHTML = step < 0 ? '<div class="mc-canvas-inner"><p>Waiting for the first canvas update…</p></div>' : data.steps[step].html;
    const inner = page.firstElementChild;
    if (inner) inner.style.zoom = String(Math.min(1, page.clientWidth / Math.max(1, inner.scrollWidth)));
    if (step >= 0 && step === shown + 1) {
      for (const id of data.steps[step].changed) {
        const block = page.querySelector('[data-section="' + CSS.escape(id) + '"]');
        if (block) { block.classList.add("is-fresh"); block.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
      }
    }
    shown = step;
  }
  let current = null;
  rows.forEach((row, index) => {
    const line = data.lines[index];
    const heard = line.at <= time;
    row.classList.toggle("is-future", !heard);
    row.classList.toggle("is-pending", heard && line.step > step);
    if (heard) current = row;
  });
  if (current && playing) current.scrollIntoView({ block: "nearest" });
  const info = step >= 0 ? data.steps[step] : null;
  status.textContent = fmt(time) + " / " + fmt(data.end) + " · update " + (step + 1) + " of " + data.steps.length +
    (info ? " · " + (info.error ? "error: " + info.error : (info.ms ?? "?") + " ms, " + info.applied + " applied" + (info.rejected ? ", " + info.rejected + " rejected" : "")) : "");
  scrub.value = String(time);
}
function tick(now) {
  if (!playing) return;
  time = Math.min(data.end, time + ((now - last) / 1000) * Number(speed.value));
  last = now;
  render();
  if (time >= data.end) { playing = false; play.textContent = "Play"; return; }
  requestAnimationFrame(tick);
}
play.onclick = () => {
  playing = !playing;
  play.textContent = playing ? "Pause" : "Play";
  if (playing) { if (time >= data.end) time = 0; last = performance.now(); requestAnimationFrame(tick); }
};
scrub.oninput = () => { time = Number(scrub.value); render(); };
document.getElementById("next").onclick = () => { const at = data.updates.find((value) => value > time + 0.01); time = at ?? data.end; render(); };
document.getElementById("prev").onclick = () => { const earlier = data.updates.filter((value) => value < time - 0.01); time = earlier.length > 1 ? earlier[earlier.length - 2] : 0; render(); };
render();
</script>
</body>
</html>
`;
}
