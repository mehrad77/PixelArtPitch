// Example code scene "finale" (the fictional QuestDay pitch), the end card: the hero walks up to the goal, the
// product's logo flies up the pole with flag(), and the final hold shows the logo, PRESS START and the URL together,
// from the last cue to the end (never the URL alone after the last cue).
import { flag, prog, rect, skyGradient, sun, text, walk } from "pap:engine";
import { DURATION, E, S, SCENES } from "pap:timeline";

// the named constants: what a person may ask to move, resize or retime (Pip edits these lines, no rewrite)
export const FLAG_X = 216;
export const POLE = 96;
export const RAISE_FOR = 1.2;
export const CARD_X = 104;
export const URL = "questday.example";

const SC = SCENES.find((s) => s.id === "finale");
const GROUND = 148;
const RAISE = [S("c04"), S("c04") + RAISE_FOR];

export function draw(t) {
  skyGradient();
  sun();
  rect(0, GROUND, 320, 32, "K");
  rect(0, GROUND, 320, 1, "l");
  // the hero walks to the foot of the pole as the cue starts, then watches the flag go up
  walk("hero", { x0: 40, x1: FLAG_X - 20, y: GROUND, t0: SC.from + 0.2, t1: S("c04"), t });
  flag("logo", { x: FLAG_X, y: GROUND, pole: POLE, t, up: prog(t, RAISE[0], RAISE[1]) });
  // the final hold: the name, PRESS START (blinking) and the URL, all from the end of the raise to the end
  if (t >= RAISE[1]) {
    text("QUESTDAY", CARD_X, 34, { align: "center", colour: "B", scale: 2 });
    if (Math.floor((t - RAISE[1]) * 2) % 2 === 0 || t > DURATION - 1)
      text("PRESS START", CARD_X, 58, { align: "center" });
    text(URL, CARD_X, 72, { align: "center", colour: "T" });
  }
}

export function sfxEvents() {
  return [
    { t: RAISE[0], type: "flag" },
    { t: Math.min(E("c04"), RAISE[1]), type: "start" },
  ];
}
