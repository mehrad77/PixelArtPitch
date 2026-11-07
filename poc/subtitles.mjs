// node subtitles.mjs -> out/video.srt (from the same CUES and TIMES that drive the burned-in captions)
import { writeFileSync } from "node:fs";
import { CUES, HOLD, TIMES } from "./timeline.mjs";

const ts = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
};
const out = CUES.map((c, i) => `${i + 1}\n${ts(TIMES[i][0] + HOLD)} --> ${ts(TIMES[i][1] + HOLD + 0.3)}\n${c}\n`).join("\n");
writeFileSync(new URL("./out/video.srt", import.meta.url).pathname, out);
const tv = (s) => ts(s).replace(",", ".");
const vtt = `WEBVTT\n\n${CUES.map((c, i) => `${tv(TIMES[i][0] + HOLD)} --> ${tv(TIMES[i][1] + HOLD + 0.3)}\n${c}\n`).join("\n")}`;
writeFileSync(new URL("./out/video.vtt", import.meta.url).pathname, vtt);
console.log(`${CUES.length} cues`);
