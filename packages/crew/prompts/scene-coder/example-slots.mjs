// Example code scene "three" (the fictional QuestDay pitch): a counted list. The script says "QuestDay gives you
// three things:" and gives each thing its own cue (c02, c03, c04), so the scene is three numbered slots that fill one
// per cue with that thing's icon, while the hero stands beside them and turns to look at each new one.
import { asset, clear, frame, rect, slots, sprite, text, walk } from "pap:engine";
import { S, SCENES } from "pap:timeline";

const SC = SCENES.find((s) => s.id === "three");
const GROUND = 148;
// slot i fills when its cue starts; what fills it is the icon of that thing
const FILLS = ["c02", "c03", "c04"].map((c) => S(c) + 0.2);
const ICONS = [
  ["items", "star"],
  ["items", "heart"],
  ["qblock", "glow"],
];
const ROW = { x: 76, y: 52, w: 48, h: 44, gap: 12 };

export function draw(t) {
  clear();
  rect(0, GROUND, 320, 32, "K");
  rect(0, GROUND, 320, 1, "l");
  // the title holds over the row for the whole scene: one short text, above it
  text("3 THINGS", 160, 30, { align: "center", colour: "B" });
  const row = slots(3, { ...ROW, filled: FILLS, t });
  row.forEach((s, i) => {
    if (!s.on || !asset(ICONS[i][0])) return;
    // the icon pops in at its slot's centre, whole pixels
    const rows = frame(ICONS[i][0], ICONS[i][1]);
    sprite(rows, s.x + Math.floor((s.w - rows[0].length) / 2), s.y + Math.floor((s.h - rows.length) / 2) + 4);
  });
  // the hero stands at the right; walk() with x0 = x1 is a character standing still, facing `face`
  const last = row.filter((s) => s.on).length;
  walk("hero", { x0: 272, x1: 272, y: GROUND, t0: SC.from, t1: SC.from, t, face: last ? "left" : "right" });
}

export function sfxEvents() {
  return FILLS.map((at) => ({ t: at, type: "coin" }));
}
