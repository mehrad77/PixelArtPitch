// The promo's pixel footage as native 320×180 PNG frames, exactly as the engine draws them (the compositor scales
// them up). Also writes stills of a moment at night, dusk and day for the "Night. Dusk. Day." beat.
//
//   node scripts/promo/pixels.mjs <project dir> <out dir> [--from 0] [--to <duration>] [--times 7.3]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encodePng, loadProject, openDoc, openRenderer } from "../../packages/render/src/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, to: { type: "string" }, times: { type: "string" } },
});
const [dir, out] = positionals;
if (!dir || !out) throw new Error("usage: pixels.mjs <project dir> <out dir>");
const FPS = 30;
const lp = loadProject(dir);
mkdirSync(join(out, "frames"), { recursive: true });

const r = await openRenderer(lp);
try {
  const from = Number(values.from ?? 0);
  const to = Number(values.to ?? lp.timeline.duration);
  for (let i = Math.round(from * FPS); i < Math.round(to * FPS); i++) {
    const f = await r.frame(i / FPS);
    writeFileSync(join(out, "frames", `${String(i).padStart(5, "0")}.png`), encodePng(320, 180, f));
  }
} finally {
  r.close();
}

// one moment at each time of day
for (const t of (values.times ?? "").split(",").filter(Boolean).map(Number))
  for (const time of ["night", "dusk", "day"]) {
    const doc = structuredClone(lp.doc);
    doc.canvas.time = time;
    const rr = await openRenderer(openDoc(dir, doc));
    try {
      writeFileSync(join(out, `still-${t}-${time}.png`), encodePng(320, 180, await rr.frame(t)));
    } finally {
      rr.close();
    }
  }
console.log(`frames in ${join(out, "frames")}`);
