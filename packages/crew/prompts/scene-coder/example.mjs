// Example code scene "quest" (the fictional QuestDay pitch): the hero walks in from the left while three stars drop
// into a row above, one per beat, and a 0-3 counter in the corner counts them. Cue c02 carries the scene.
// Every time comes from the script (S/E of a cue, the scene's window), never a raw second, so a re-timed script
// moves the beats with it. The sky is drawn for TIME (night, dusk or day), never a hard-coded night.
import {
  asset,
  clamp,
  clouds,
  ease,
  frame,
  prog,
  rect,
  skyGradient,
  sprite,
  stars,
  step,
  sun,
  TIME,
  text,
  walk,
} from "pap:engine";
import { E, S, SCENES } from "pap:timeline";

// the named constants: what a person may ask to move, resize or retime (Pip edits these lines, no rewrite)
export const HERO_X = 64;
export const STAR_X = 128;
export const STAR_Y = 64;
export const STAR_GAP = 32;
export const WALK_IN = 1;
export const FIRST_STAR = 0.4;

const ID = "quest";
const SC = SCENES.find((s) => s.id === ID);
const GROUND = 148;
// the beats: the hero walks in over the first second, then the three stars land evenly across cue c02
const WALK0 = SC.from + 0.2;
const WALK1 = S("c02") + WALK_IN;
const T0 = S("c02") + FIRST_STAR;
const GAP = (E("c02") - T0) / 3.5;
const LANDS = [0, 1, 2].map((i) => T0 + i * GAP);

// what never changes is worked out once, at load time (draw must stay well under 250 ms)
const TILES = asset("tiles") ? [frame("tiles", "ground-top"), frame("tiles", "ground")] : null;

function backdrop(t) {
  // the sky for the video's time of day: stars and the moon at night, the sun and clouds by day, a low sun at dusk
  skyGradient();
  stars(t);
  sun();
  clouds(t);
  if (TIME === "night" && asset("moon")) sprite(frame("moon", "moon"), 268, 14);
  if (TILES)
    for (let x = 0; x < 320; x += 16) {
      sprite(TILES[0], x, GROUND);
      sprite(TILES[1], x, GROUND + 16);
    }
  else rect(0, GROUND, 320, 32, "K");
}

export function draw(t) {
  backdrop(t);
  // the hero walks from off the left edge to x = 64: walk() steps its run cycle with the distance and turns it to
  // face where it goes; before and after, it breathes on its idle frames
  walk("hero", { x0: -12, x1: HERO_X, y: GROUND, t0: WALK0, t1: WALK1, t });
  let got = 0;
  LANDS.forEach((at, i) => {
    const k = prog(t, at - 0.5, at);
    if (k <= 0) return;
    // each star falls from above the frame and settles in its place, whole pixels only
    const x = STAR_X + i * STAR_GAP;
    const y = step(-16 + (STAR_Y - -16) * ease(k));
    sprite(frame("items", "star"), x, y);
    if (k >= 1) got++;
  });
  // one short text in the scene: the counter, top right, clear of the caption zone (it ends above y = 146)
  text(`${got}/3`, 304, 8, { align: "right", colour: "B" });
  // a flash line under the star just landed, for 0.2 s
  LANDS.forEach((at, i) => {
    const f = clamp((t - at) / 0.2);
    if (f > 0 && f < 1) rect(STAR_X - 4 + i * STAR_GAP, STAR_Y + 18, 24, 1, "B", 1 - f);
  });
}

// the sounds come from the same beats as the motion: a coin as each star lands
export function sfxEvents() {
  return LANDS.map((at) => ({ t: at, type: "coin" }));
}
