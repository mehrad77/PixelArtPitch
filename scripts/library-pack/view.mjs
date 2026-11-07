// node src/view.mjs id [id...] -> preview/view.png: the frames of the given assets at 6x on sky and K
import { readFileSync } from "node:fs";
import { OUT, preview } from "./lib.mjs";

const frames = [];
for (const id of process.argv.slice(2)) {
  const a = JSON.parse(readFileSync(`${OUT}/assets/${id}/asset.json`, "utf8"));
  for (const f of a.frames) frames.push(a.grid[f]);
}
const w = Math.max(...frames.map((f) => f[0].length));
preview("view.png", frames, { scale: 6, columns: Math.max(1, Math.min(8, Math.floor(1500 / (w * 6 + 12)))) });
