// Example code scene "finale" (the fictional QuestDay pitch), the end card: the hero walks up to the goal, the
// product's logo flies up the pole with flag(), and the final hold shows the logo, PRESS START and the URL together,
// from the last cue to the end (never the URL alone after the last cue).
import { clear, flag, prog, rect, text, walk } from "pap:engine";
import { DURATION, E, S, SCENES } from "pap:timeline";

const SC = SCENES.find((s) => s.id === "finale");
const GROUND = 148;
const RAISE = [S("c04"), S("c04") + 1.2];

export function draw(t) {
  clear();
  rect(0, GROUND, 320, 32, "K");
  rect(0, GROUND, 320, 1, "l");
  // the hero walks to the foot of the pole as the cue starts, then watches the flag go up
  walk("hero", { x0: 40, x1: 196, y: GROUND, t0: SC.from + 0.2, t1: S("c04"), t });
  flag("logo", { x: 216, y: GROUND, pole: 96, t, up: prog(t, RAISE[0], RAISE[1]) });
  // the final hold: the name, PRESS START (blinking) and the URL, all from the end of the raise to the end
  if (t >= RAISE[1]) {
    text("QUESTDAY", 104, 34, { align: "center", colour: "B", scale: 2 });
    if (Math.floor((t - RAISE[1]) * 2) % 2 === 0 || t > DURATION - 1) text("PRESS START", 104, 58, { align: "center" });
    text("questday.example", 104, 72, { align: "center", colour: "T" });
  }
}

export function sfxEvents() {
  return [
    { t: RAISE[0], type: "flag" },
    { t: Math.min(E("c04"), RAISE[1]), type: "start" },
  ];
}
