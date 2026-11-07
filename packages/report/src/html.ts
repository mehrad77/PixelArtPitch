// The report page: one self-contained index.html with the summary embedded as JSON; images sit next to it in img/.
// Dark only, like the studio. The chart colours are a validated set on the panel surface (#101512 and #141b17):
// work #3987e5, fallback #c98500, failed #d03b3b, thinking #d95926.
import type { Summary } from "./summarize.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** the summary as a <script type="application/json"> body: no "</script>" can close it early */
export const embed = (s: unknown) =>
  JSON.stringify(s)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export function renderHtml(s: Summary): string {
  const title = s.project.title || s.project.id;
  return PAGE.replace("__TITLE__", esc(`${title} · run report`)).replace("__DATA__", () => embed(s));
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="pap report">
<title>__TITLE__</title>
<style>
/* One reading column on a night sky; wide figures (the timeline, the sheets) take the full width. */
:root {
  color-scheme: dark;
  --sky: #0d120f;
  --panel: #141b17;
  --surface: #101512;
  --line: #253029;
  --ink: #e9e6da;
  --ink-2: #b3b7ac;
  --ink-3: #8a9086;
  --lamp: #f0c36d;
  --answer: #3987e5;
  --thinking: #d95926;
  --work: #3987e5;
  --fallback: #c98500;
  --failed: #d03b3b;
  --font-display: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --font-body: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --font-data: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --col: 44rem;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--sky); color: var(--ink); font: 400 1.05rem/1.6 var(--font-body); padding-inline: 16px; }
main { max-width: 72rem; margin: 0 auto; padding-block: 3rem 5rem; display: grid; gap: 3.5rem; }
.col { max-width: var(--col); }
h1, h2, h3 { text-wrap: balance; margin: 0; font-weight: 600; }
h1 { font-family: var(--font-display); font-weight: 700; font-size: clamp(2rem, 6vw, 3.2rem); line-height: 1.05; color: var(--lamp); letter-spacing: -.01em; }
h2 { font-family: var(--font-display); font-weight: 700; font-size: 1.3rem; color: var(--lamp); }
h3 { font-size: 1.1rem; }
p { margin: 0; }
a { color: var(--lamp); }
.eyebrow { font: 600 .72rem/1 var(--font-data); letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); }
.lede { font-size: 1.2rem; line-height: 1.5; }
.muted { color: var(--ink-2); }
.small { font-size: .92rem; }
section { display: grid; gap: 1.25rem; }
.stack { display: grid; gap: .8rem; align-content: start; }
code, .mono { font-family: var(--font-data); font-size: .86em; }
.num { font-family: var(--font-data); font-variant-numeric: tabular-nums; }
.empty { color: var(--ink-3); font-style: italic; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.stat { background: var(--sky); padding: 1rem 1.1rem; display: grid; gap: .25rem; }
.stat b { font: 600 1.6rem/1.1 var(--font-data); font-variant-numeric: tabular-nums; }
.stat span { font-size: .9rem; color: var(--ink-2); }
figure { margin: 0; display: grid; gap: .5rem; min-width: 0; }
figcaption { font-size: .9rem; color: var(--ink-2); }
.pix { image-rendering: pixelated; display: block; width: 100%; height: auto; background: #000; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem 2rem; align-items: start; }
.private { display: grid; place-items: center; min-height: 8rem; background: repeating-linear-gradient(45deg, #1a221d 0 6px, var(--surface) 6px 12px); border: 1px dashed #5d4a1c; color: #f3c45b; font: 600 .75rem/1 var(--font-data); letter-spacing: .1em; text-transform: uppercase; }
.assets { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1rem; align-items: start; }
.asset { background: var(--panel); border: 1px solid var(--line); display: grid; }
.asset .sheet { background: var(--surface); padding: .75rem; border-bottom: 1px solid var(--line); display: grid; gap: .5rem; }
.asset .sheet.two { grid-template-columns: 1fr 1fr; }
.asset .sheet img { image-rendering: pixelated; width: 100%; height: auto; display: block; }
.asset .body { padding: .9rem 1rem 1rem; display: grid; gap: .5rem; }
.tags { display: flex; flex-wrap: wrap; gap: .35rem; }
.tag { font: 600 .7rem/1 var(--font-data); letter-spacing: .06em; text-transform: uppercase; padding: .32rem .45rem; border: 1px solid var(--line); color: var(--ink-2); }
.tag.good { color: #9fe39f; border-color: #2d5a2d; }
.tag.warn { color: #f3c45b; border-color: #5d4a1c; }
.tag.bad { color: #f19a9a; border-color: #5c2626; }
dl.kv { display: grid; grid-template-columns: auto 1fr; gap: .15rem .9rem; margin: 0; font-size: .92rem; }
dl.kv dt { color: var(--ink-3); }
dl.kv dd { margin: 0; font-family: var(--font-data); font-size: .85rem; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
#timeline { display: block; }
.legend { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; font-size: .88rem; color: var(--ink-2); }
.legend i { display: inline-block; width: .9rem; height: .9rem; vertical-align: -.15rem; margin-right: .35rem; border-radius: 2px; }
#tip { position: fixed; z-index: 20; pointer-events: none; max-width: 22rem; background: #1d2621; border: 1px solid #3a473f; padding: .55rem .7rem; font-size: .85rem; line-height: 1.45; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
#tip b { font-family: var(--font-data); font-size: .8rem; }
.bars { display: grid; gap: .45rem; }
.bar-row { display: grid; grid-template-columns: 9.5rem 1fr 6.5rem; gap: .75rem; align-items: center; font-size: .92rem; }
.bar-row .track { height: 14px; position: relative; }
.bar-row .fill { position: absolute; inset: 0 auto 0 0; background: var(--answer); border-radius: 0 4px 4px 0; }
.bar-row .val, .stack-row .val { font-family: var(--font-data); font-size: .82rem; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.stack-row { display: grid; grid-template-columns: 10.5rem 1fr 7.5rem; gap: .75rem; align-items: center; font-size: .88rem; }
.stack-row .track { height: 14px; display: flex; gap: 2px; }
.stack-row .seg { height: 100%; }
.stack-row .seg.t { background: var(--thinking); }
.stack-row .seg.a { background: var(--answer); border-radius: 0 4px 4px 0; }
.stack-row .lbl { font-family: var(--font-data); font-size: .8rem; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.flag { color: #f19a9a; }
@media (max-width: 40rem) {
  .bar-row { grid-template-columns: 7rem 1fr 5rem; }
  .stack-row { grid-template-columns: 7.5rem 1fr 5.5rem; }
}
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { padding: .5rem .6rem; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font: 600 .72rem/1.3 var(--font-data); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
td.cell { text-align: center; font-family: var(--font-data); font-variant-numeric: tabular-nums; }
.tablewrap { overflow-x: auto; }
ol.picks { margin: 0; padding-left: 1.4rem; display: grid; gap: .9rem; }
ol.picks li::marker { font-family: var(--font-data); color: var(--ink-3); font-size: .85rem; }
.pick-where { color: var(--ink-2); font-size: .92rem; }
.pick-chose { font-weight: 600; }
.findings { display: grid; gap: 1.6rem; }
.fgroup { display: grid; gap: .6rem; }
.fgroup ul { margin: 0; padding-left: 1.15rem; display: grid; gap: .55rem; }
.fgroup li { max-width: var(--col); }
.fgroup li ul { margin-top: .4rem; gap: .3rem; }
.sev { font: 600 .68rem/1 var(--font-data); letter-spacing: .08em; margin-right: .5rem; color: var(--ink-3); }
ul.plain { margin: 0; padding-left: 1.15rem; display: grid; gap: .55rem; }
details { border-top: 1px solid var(--line); padding-top: .8rem; }
summary { cursor: pointer; color: var(--ink-2); font-size: .95rem; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--lamp); outline-offset: 2px; }
pre.raw { white-space: pre-wrap; font: .8rem/1.55 var(--font-data); color: var(--ink-2); background: var(--panel); padding: 1rem; border: 1px solid var(--line); overflow-x: auto; }
footer { color: var(--ink-3); font-size: .85rem; }
</style>
</head>
<body>
<main>
  <header class="stack col">
    <span class="eyebrow" id="eyebrow"></span>
    <h1 id="title"></h1>
    <p class="lede" id="lede"></p>
    <p class="small muted" id="exported"></p>
  </header>

  <section aria-label="The run in numbers">
    <div class="stats" id="stats"></div>
    <p class="small muted col">Every number on this page comes from the project's own files: the ledger of model calls, the event log, the plan history and Pip's thread. Times are minutes from the first mark on the timeline; the clock in the tooltips is your local time.</p>
  </section>

  <section>
    <span class="eyebrow">What came out</span>
    <h2>The cut</h2>
    <div class="pair" id="outputs"></div>
  </section>

  <section>
    <span class="eyebrow">The new art</span>
    <h2>What the crew drew</h2>
    <p class="col muted">The project's own assets and every variant the Pixel artist drew. Cost and time count the model calls of that asset's drawing tasks.</p>
    <div class="assets" id="assets"></div>
  </section>

  <section>
    <span class="eyebrow">How the run went</span>
    <h2>The crew, minute by minute</h2>
    <p class="col">One lane per crew member, in role order. Pip's turns are the dots on the top lane; the ticks above it are plan revisions; dashed red lines are incidents. Hatched bands are the times the run waited on you. Hover any mark for what it was.</p>
    <div class="legend" aria-hidden="true">
      <span><i style="background:var(--work)"></i>Working, done</span>
      <span><i style="background:var(--fallback)"></i>Fell back to a stand-in</span>
      <span><i style="background:var(--failed)"></i>Failed</span>
      <span><i style="background:repeating-linear-gradient(45deg,#e9e6da55 0 2px,transparent 2px 6px);border:1px solid #e9e6da66"></i>Waiting on you</span>
      <span><i style="background:#f0c36d;border-radius:50%"></i>Pip's turn</span>
    </div>
    <div class="scroll"><svg id="timeline" role="img" aria-label="Timeline of the run by crew member"></svg></div>
    <details><summary>The same timeline as a table</summary><div class="tablewrap"><table id="laneTable"></table></div></details>
  </section>

  <section>
    <span class="eyebrow">How Pip worked</span>
    <h2>Plan revisions</h2>
    <p class="col muted">Rev 0 is the rules plan. Later revisions come from code (a storyboard's expansion), from you, or from Pip acting as conductor between steps. Each one's estimate sits next to what had been spent when it was made.</p>
    <div class="tablewrap"><table id="revTable"></table></div>
    <p class="small muted col" id="estLine"></p>
  </section>

  <section>
    <span class="eyebrow">How the crew cooperated</span>
    <h2>Where the money and the time went</h2>
    <div class="pair">
      <div class="stack"><h3>Cost by role</h3><div class="bars" id="costBars"></div></div>
      <div class="stack"><h3>Model time by role</h3><div class="bars" id="timeBars"></div></div>
    </div>
    <div class="stack col">
      <h3>Every project in this home over the same time</h3>
      <div class="tablewrap"><table id="projTable"></table></div>
    </div>
  </section>

  <section>
    <span class="eyebrow">Weaknesses</span>
    <h2>Where it failed most</h2>
    <div class="pair">
      <div class="stack">
        <h3>Failures by role</h3>
        <div class="tablewrap"><table id="heat"></table></div>
        <p class="small muted">Counted from the ledger (calls that hit the token limit) and the event log (tasks that failed or fell back). A pause is not a failure.</p>
      </div>
      <div class="stack">
        <h3 id="thinkTitle">Thinking against answer</h3>
        <div class="legend" aria-hidden="true"><span><i style="background:var(--thinking)"></i>Thinking tokens</span><span><i style="background:var(--answer)"></i>Answer tokens</span></div>
        <div class="bars" id="thinkBars"></div>
        <p class="small muted" id="thinkNote"></p>
      </div>
    </div>
    <div class="stack col" id="couldntWrap">
      <h3>What the crew said it couldn't do</h3>
      <ul class="plain" id="couldnt"></ul>
    </div>
  </section>

  <section id="picksWrap" hidden>
    <span class="eyebrow">The picks</span>
    <h2>What was chosen, and why</h2>
    <ol class="picks col" id="picks"></ol>
  </section>

  <section id="findingsWrap" hidden>
    <span class="eyebrow">Findings</span>
    <h2>Everything the run turned up</h2>
    <div class="findings" id="findings"></div>
    <details><summary>The raw notes, as written</summary><pre class="raw" id="raw"></pre></details>
  </section>

  <footer>Made by <code>pap report</code>. Keys, tokens and anything under the project's <code>private/</code> are never included; assets flagged private, likeness or brand show only a label.</footer>
</main>
<div id="tip" hidden></div>

<script type="application/json" id="data">__DATA__</script>
<script>
const S = JSON.parse(document.getElementById("data").textContent);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const inline = (s) => esc(s).replace(/\`([^\`]+)\`/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
const usd = (n) => "$" + Number(n || 0).toFixed(2);
const mmss = (s) => \`\${Math.floor(s / 60)}:\${String(Math.round(s % 60)).padStart(2, "0")}\`;
const clock = (s) => new Date((S.t0 + s) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const max = (xs) => xs.length ? Math.max(...xs) : 0;
const empty = (el, text) => { el.innerHTML = \`<p class="empty">\${esc(text)}</p>\`; };

// ---- header and numbers ----
const day = new Date(S.t0 * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
$("eyebrow").textContent = \`PixelArtPitch · run report\${S.window.run ? " · " + S.window.run : ""} · \${day}\`;
$("title").textContent = S.project.title || S.project.id;
if (S.project.idea) $("lede").innerHTML = \`The brief: <em>"\${esc(S.project.idea)}"</em>\`;
const runs = S.window.runs;
$("exported").textContent = (S.exported.length ? "Exported: " + S.exported.join(", ") + ". " : "Not exported yet. ") +
  (runs.length ? \`\${runs.length} run\${runs.length === 1 ? "" : "s"}: \${runs.map((r) => r.status).join(", ")}.\` : "");
$("stats").innerHTML = S.stats.map(([b, s]) => \`<div class="stat"><b>\${esc(b)}</b><span>\${esc(s)}</span></div>\`).join("");

// ---- outputs ----
if (S.outputs.length) $("outputs").innerHTML = S.outputs.map((o) => o.file
  ? \`<figure><img class="pix" src="\${esc(o.file)}" alt="\${esc(o.label)}"><figcaption>\${esc(o.label)}\${o.private ? " (shows private assets)" : ""}</figcaption></figure>\`
  : \`<figure><div class="private">private</div><figcaption>\${esc(o.label)}: hidden, it shows assets flagged private. Run with --include-private to show it.</figcaption></figure>\`).join("");
else empty($("outputs"), "No contact sheet yet: the cut hasn't been rendered.");

// ---- assets ----
if (S.assets.length) $("assets").innerHTML = S.assets.map((a) => {
  const sheet = a.images.length
    ? \`<div class="sheet \${a.images.length > 1 ? "two" : ""}">\${a.images.map((i) => \`<img src="\${esc(i.file)}" alt="\${esc(i.label)} sprite sheet">\`).join("")}</div>\`
    : \`<div class="sheet"><div class="private">\${a.private ? "private" : "no image"}</div></div>\`;
  const what = [a.kind, a.size, a.frames ? a.frames + " frames" : ""].filter(Boolean).join(" · ");
  return \`<article class="asset">\${sheet}<div class="body"><h3>\${esc(a.id.replace(/_/g, " "))}</h3>
  <div class="tags">\${a.tags.map(([t, c]) => \`<span class="tag \${c}">\${esc(t)}</span>\`).join("")}</div>
  \${what ? \`<p class="small mono muted">\${esc(what)}</p>\` : ""}\${a.description ? \`<p class="small">\${esc(a.description)}</p>\` : ""}
  <dl class="kv"><dt>Cost</dt><dd>\${usd(a.usd)} · \${a.calls} calls</dd><dt>Model time</dt><dd>\${mmss(a.sec)}</dd><dt>Hit the limit</dt><dd>\${a.limit} of \${a.calls}</dd></dl></div></article>\`;
}).join("");
else empty($("assets"), "The crew drew nothing new: every asset came from the library.");

// ---- timeline ----
(function timeline() {
  const svg = $("timeline"), tip = $("tip");
  const lanes = S.lanes;
  const step = S.dur > 5400 ? 900 : S.dur > 2400 ? 600 : S.dur > 900 ? 300 : 60;
  const dur = Math.max(step, Math.ceil(S.dur / step) * step);
  const left = 190, right = 24, top = 46, row = 22, W = Math.max(900, svg.parentElement.clientWidth || 900);
  const H = top + (lanes.length + 2) * row + 28;
  const x = (s) => left + (s / dur) * (W - left - right);
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("viewBox", \`0 0 \${W} \${H}\`);
  const mono = 'font-family="ui-monospace, Menlo, monospace"';
  const parts = [\`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" fill="#e9e6da" fill-opacity=".35"/></pattern></defs>\`];
  const C = { work: "#3987e5", fallback: "#c98500", failed: "#d03b3b" };
  for (let t = 0; t <= dur; t += step) {
    const gx = x(t);
    parts.push(\`<line x1="\${gx}" x2="\${gx}" y1="\${top - 6}" y2="\${H - 22}" stroke="#253029"/><text x="\${gx}" y="\${H - 6}" fill="#8a9086" font-size="11" \${mono} text-anchor="middle">\${Math.round(t / 60)}m</text>\`);
  }
  for (const r of S.revs) {
    const rx = x(r.t);
    parts.push(\`<g data-tip="\${esc(\`<b>Plan rev \${r.rev}</b> · by \${esc(r.by)} (\${esc(r.trigger)}) · \${clock(r.t)}<br>\${esc(r.reason)}\${r.adds ? \`<br>\${r.adds} tasks added\` : ""}\`)}"><rect x="\${rx - 6}" y="8" width="12" height="20" fill="transparent"/><line x1="\${rx}" x2="\${rx}" y1="12" y2="26" stroke="#f0c36d" stroke-width="2"/></g>\`);
  }
  parts.push(\`<text x="12" y="23" fill="#8a9086" font-size="11" \${mono}>plan revisions</text>\`);
  for (const i of S.incidents) {
    const ix = x(i.t);
    parts.push(\`<g data-tip="\${esc(\`<b>\${esc(i.label)}</b> · \${clock(i.t)}\`)}"><line x1="\${ix}" x2="\${ix}" y1="\${top - 6}" y2="\${H - 22}" stroke="#d03b3b" stroke-width="1.5" stroke-dasharray="3 3"/><rect x="\${ix - 5}" y="\${top - 6}" width="10" height="\${H - top - 16}" fill="transparent"/></g>\`);
  }
  let y = top;
  parts.push(\`<text x="12" y="\${y + 15}" fill="#e9e6da" font-size="12" \${mono}>Pip</text>\`);
  for (const d of S.pipDots) {
    const dx = x(d.t), you = d.kind === "user";
    parts.push(\`<g data-tip="\${esc(\`<b>\${you ? "You" : "Pip"}</b> · \${clock(d.t)}<br>\${esc(d.text)}\${d.cards.length ? \`<br>Card: \${esc(d.cards.join("; "))}\` : ""}\`)}"><circle cx="\${dx}" cy="\${y + 11}" r="\${you ? 4 : 5}" fill="\${you ? "#0d120f" : "#f0c36d"}" stroke="#f0c36d" stroke-width="2"/><circle cx="\${dx}" cy="\${y + 11}" r="10" fill="transparent"/></g>\`);
  }
  y += row;
  parts.push(\`<text x="12" y="\${y + 15}" fill="#e9e6da" font-size="12" \${mono}>Waiting on you</text>\`);
  for (const w of S.you) parts.push(\`<rect x="\${x(w.s)}" y="\${y + 4}" width="\${Math.max(3, x(w.e) - x(w.s))}" height="\${row - 8}" fill="url(#hatch)" stroke="#e9e6da" stroke-opacity=".4" data-tip="\${esc(\`<b>\${esc(w.title)}</b> open \${mmss(w.e - w.s)} · \${clock(w.s)}–\${clock(w.e)}\`)}"/>\`);
  y += row;
  for (const l of lanes) {
    parts.push(\`<text x="12" y="\${y + 15}" fill="#b3b7ac" font-size="12" \${mono}>\${esc(l.name.length > 24 ? l.name.slice(0, 23) + "…" : l.name)}</text><line x1="\${left}" x2="\${W - right}" y1="\${y + row - 1}" y2="\${y + row - 1}" stroke="#1b231e"/>\`);
    for (const b of l.bars) {
      const bx = x(b.s), bw = Math.max(3, x(b.e) - x(b.s));
      parts.push(\`<rect x="\${bx}" y="\${y + 5}" width="\${bw}" height="\${row - 10}" rx="2" fill="\${C[b.state]}" stroke="#141b17" stroke-width="1" data-tip="\${esc(\`<b>\${esc(b.title)}</b><br>\${clock(b.s)}–\${clock(b.e)} · \${mmss(b.e - b.s)}\${b.model ? " · " + esc(b.model) : ""} · \${usd(b.usd)}\${b.why ? \`<br>\${esc(b.why)}\` : ""}\`)}"/>\`);
    }
    y += row;
  }
  svg.innerHTML = parts.join("");
  const show = (e) => { const t = e.target.closest("[data-tip]"); if (!t) { tip.hidden = true; return; } tip.innerHTML = t.getAttribute("data-tip"); tip.hidden = false; const r = tip.getBoundingClientRect(); let lx = e.clientX + 14, ly = e.clientY + 14; if (lx + r.width > innerWidth - 8) lx = e.clientX - r.width - 14; if (ly + r.height > innerHeight - 8) ly = e.clientY - r.height - 14; tip.style.left = lx + "px"; tip.style.top = ly + "px"; };
  svg.addEventListener("mousemove", show); svg.addEventListener("mouseleave", () => (tip.hidden = true));
  const rows = lanes.flatMap((l) => l.bars.map((b) => [l.name, b.title, \`\${clock(b.s)}–\${clock(b.e)}\`, { work: "done", fallback: "fell back", failed: "failed" }[b.state], usd(b.usd)]));
  $("laneTable").innerHTML = \`<tr><th>Crew member</th><th>Task</th><th>Time</th><th>Result</th><th>Cost</th></tr>\` + rows.map((r) => \`<tr>\${r.map((c) => \`<td>\${esc(c)}</td>\`).join("")}</tr>\`).join("");
})();

// ---- revisions and estimates ----
const BY = { rules: "Rules", code: "Code", pip: "Pip", person: "You" };
if (S.revs.length) {
  $("revTable").innerHTML = \`<tr><th>Rev</th><th>At</th><th>By</th><th>Why</th><th class="num">Added</th><th class="num">Estimate</th><th class="num">Spent by then</th></tr>\` +
    S.revs.map((r) => \`<tr><td class="num">\${r.rev}</td><td class="num">\${mmss(Math.max(0, r.t))}</td><td>\${esc(BY[r.by] ?? r.by)}</td><td>\${esc(r.reason)}</td><td class="num">\${r.adds}</td><td class="num">\${r.est ? usd(r.est[0]) + "–" + usd(r.est[1]) : "–"}</td><td class="num">\${usd(r.spent)}</td></tr>\`).join("");
  const first = S.revs.find((r) => r.est);
  if (first) {
    const [lo, hi] = first.est;
    const verdict = S.total > hi ? \`×\${(S.total / Math.max(hi, 0.01)).toFixed(1)} over the high end\` : S.total < lo ? "under the low end" : "inside the range";
    $("estLine").textContent = \`The first estimate was \${usd(lo)}–\${usd(hi)}; the run cost \${usd(S.total)}, \${verdict}.\`;
  }
} else empty($("revTable").parentElement, "No plan revisions in this window.");

// ---- bars ----
function bars(el, rows, val, fmt) {
  if (!rows.length) return empty(el, "No model calls.");
  const m = max(rows.map(val)) || 1;
  el.innerHTML = rows.map((r) => \`<div class="bar-row"><span>\${esc(r.label)}</span><span class="track"><span class="fill" style="width:\${(val(r) / m) * 100}%"></span></span><span class="val">\${fmt(r)}</span></div>\`).join("");
}
const roles = S.byRole.filter((r) => r.usd > 0.005 || r.sec > 1);
bars($("costBars"), roles, (r) => r.usd, (r) => usd(r.usd));
bars($("timeBars"), [...roles].sort((a, b) => b.sec - a.sec), (r) => r.sec, (r) => mmss(r.sec));
if (S.byProject.length) $("projTable").innerHTML = \`<tr><th>Project</th><th class="num">Calls</th><th class="num">Cost</th></tr>\` +
  S.byProject.map((p) => \`<tr><td>\${esc(p.project)}\${p.self ? " (this one)" : ""}</td><td class="num">\${p.n}</td><td class="num">\${usd(p.usd)}</td></tr>\`).join("");
else empty($("projTable").parentElement, "No model calls.");

// ---- thinking ----
const T = S.thinking;
if (T && T.calls.length) {
  $("thinkTitle").textContent = \`The \${T.label}: thinking against answer\`;
  const pm = max(T.calls.map((c) => c.think + c.answer)) || 1;
  $("thinkBars").innerHTML = T.calls.map((c) => {
    const t = (c.think / pm) * 100, a = (c.answer / pm) * 100;
    return \`<div class="stack-row" title="\${esc(\`\${c.what} \${c.kind}: \${c.think} thinking + \${c.answer} answer tokens, \${c.sec} s, \${usd(c.usd)}, \${c.model}\`)}"><span class="lbl">\${esc(c.what)} · \${esc(c.kind)}</span><span class="track">\${c.think ? \`<span class="seg t" style="width:\${t}%"></span>\` : ""}\${c.answer ? \`<span class="seg a" style="width:\${a}%"></span>\` : ""}</span><span class="val">\${c.stop === "max_tokens" ? '<span class="flag">limit</span> ' : ""}\${Math.round(c.sec)} s</span></div>\`;
  }).join("");
  const lim = T.calls.filter((c) => c.stop === "max_tokens").length;
  $("thinkNote").textContent = \`\${T.share}% of the \${T.label}'s output tokens were thinking, over \${T.calls.length} calls\${lim ? \`; \${lim} hit the token limit\` : ""}. A call that thinks until the limit has no answer left.\`;
} else empty($("thinkBars"), "No call reported thinking tokens.");

// ---- heatmap ----
const K = S.fail.kinds;
if (K.length) {
  const hmax = max(S.fail.rows.flatMap((r) => Object.values(r.counts))) || 1;
  const ramp = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab"];
  $("heat").innerHTML = \`<tr><th>Role</th>\${K.map((k) => \`<th>\${esc(k.label)}</th>\`).join("")}</tr>\` + S.fail.rows.map((r) =>
    \`<tr><td>\${esc(r.label)}</td>\${K.map((k) => { const n = r.counts[k.kind] ?? 0; const bg = n ? ramp[Math.min(3, Math.floor((n / hmax) * 3.99))] : "transparent"; const fg = n && n / hmax > 0.5 ? "#e9e6da" : n ? "#0d120f" : "#8a9086"; return \`<td class="cell" style="background:\${bg};color:\${fg}">\${n || "·"}</td>\`; }).join("")}</tr>\`).join("");
} else empty($("heat").parentElement, "Nothing failed or fell back.");

const said = (c) => \`<li><b>\${esc(c.from)}</b> <span class="num muted">\${mmss(Math.max(0, c.t))}</span>: \${esc(c.text)}</li>\`;
if (S.couldnt.length) {
  $("couldnt").innerHTML = S.couldnt.slice(0, 6).map(said).join("");
  if (S.couldnt.length > 6) $("couldnt").insertAdjacentHTML("afterend", \`<details><summary>\${S.couldnt.length - 6} more</summary><ul class="plain">\${S.couldnt.slice(6).map(said).join("")}</ul></details>\`);
} else $("couldntWrap").hidden = true;

// ---- picks and findings (only when given) ----
if (S.picks && S.picks.length) {
  $("picksWrap").hidden = false;
  $("picks").innerHTML = S.picks.map((p) => \`<li><div class="pick-where">\${p.project ? esc(p.project) + " · " : ""}\${esc(p.where)}</div><div><span class="pick-chose">\${esc(p.chose)}</span>\${p.by === "person" ? ' <span class="tag good">yours</span>' : ""}</div>\${p.why ? \`<div class="small">\${esc(p.why)}</div>\` : ""}</li>\`).join("");
}
if (S.findings && (S.findings.groups.length || S.findings.raw)) {
  $("findingsWrap").hidden = false;
  $("findings").innerHTML = S.findings.groups.map((g) => \`<div class="fgroup"><h3><span class="sev">\${g.items.length}</span>\${esc(g.title)}</h3><ul>\${g.items.map((i) => \`<li>\${inline(i.text)}\${i.sub.length ? \`<ul>\${i.sub.map((s) => \`<li>\${inline(s)}</li>\`).join("")}</ul>\` : ""}</li>\`).join("")}</ul></div>\`).join("");
  $("raw").textContent = S.findings.raw;
}
</script>
</body>
</html>
`;
