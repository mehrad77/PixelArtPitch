// node src/all.mjs: run every wave, write contact sheets, index-rows.json and sheets/index.html
import { writeFileSync } from "node:fs";
import { ALL, contactSheet, OUT } from "./lib.mjs";

const WAVES = ["w1-ground", "w1-build", "w1-sky", "w1-plants", "w2-small", "w2-big", "w3-icons", "w4-fx"];
for (const w of WAVES) await import(`./${w}.mjs`);
const waves = [...new Set(ALL.map((a) => a.wave))];
for (const w of waves) contactSheet(w);
const rows = ALL.map(({ doc }) => ({
  id: doc.id,
  kind: doc.kind,
  w: doc.w,
  h: doc.h,
  frames: doc.frames.length,
  tags: doc.tags,
}));
writeFileSync(`${OUT}/index-rows.json`, `${JSON.stringify(rows, null, 1)}\n`);
const TITLES = {
  "w1-ground": "Ground",
  "w1-build": "Floors, walls, roofs, water",
  "w1-sky": "Sky",
  "w1-plants": "Plants",
  "w2-props": "Props",
  "w3-icons": "Icons",
  "w4-fx": "FX",
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Library picks</title><style>
:root{--bg:#0f1411;--fg:#e6e4da;--dim:#9a9d93;--acc:#6cbf8e;--card:#161d18}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px}
h1{font-size:22px}h2{color:var(--acc);margin-top:40px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.card{background:var(--card);border-radius:6px;padding:12px}
.card img{width:100%;image-rendering:pixelated;background:#0f1411}
code{color:var(--acc);font-size:15px}.meta{color:var(--dim);font-size:13px}
details img{max-width:100%;image-rendering:pixelated}
</style></head><body>
<h1>Authored library assets: ${ALL.length} assets, ${ALL.reduce((n, a) => n + a.doc.frames.length, 0)} frames</h1>
<p class="meta">Drawn in code (palette pap-night@1). Each card shows the asset's sheet.png. The wave contact sheet (with 1x/2x strips and tiled previews) is under each heading.</p>
${waves
  .map(
    (w) => `<h2>${TITLES[w] ?? w}</h2>
<details><summary>Contact sheet ${w}.png</summary><img src="${w}.png" alt="contact sheet ${w}"></details>
<div class="grid">${ALL.filter((a) => a.wave === w)
      .map(
        ({
          doc,
        }) => `<div class="card"><code>${doc.id}</code> <span class="meta">${doc.kind} ${doc.w}x${doc.h}, ${doc.frames.length} frames</span>
<img src="../assets/${doc.id}/sheet.png" alt="${doc.id}">
<div class="meta">${esc(doc.frames.join(", "))}</div><p class="meta">${esc(doc.description)}</p><div class="meta">tags: ${doc.tags.join(", ")}</div></div>`,
      )
      .join("\n")}</div>`,
  )
  .join("\n")}
</body></html>`;
writeFileSync(`${OUT}/sheets/index.html`, html);
console.log(
  ALL.length,
  "assets",
  ALL.reduce((n, a) => n + a.doc.frames.length, 0),
  "frames",
);
for (const a of ALL)
  console.log(
    a.wave,
    a.doc.id,
    a.doc.frames.length,
    a.doc.standard.ok,
    a.doc.standard.soft.filter((s) => /dim/.test(s)).join(" "),
  );
