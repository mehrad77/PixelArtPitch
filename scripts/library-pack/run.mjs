// node src/run.mjs w1-ground [w1-...]: run wave recipes, then write one contact sheet per wave
import { ALL, contactSheet } from "./lib.mjs";

const files = process.argv.slice(2);
for (const f of files) await import(`./${f}.mjs`);
for (const w of new Set(ALL.map((a) => a.wave))) contactSheet(w);
for (const a of ALL) console.log(a.doc.id, a.doc.frames.length, JSON.stringify(a.doc.standard.stats));
