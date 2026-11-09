// Example code scene "quest" (the fictional QuestDay pitch): the hero stands on the ground while three stars drop
// into a row above, one per beat, and a 0-3 counter in the corner counts them. Cue c02 carries the scene.
// Every time comes from the script (S/E of a cue, the scene's window), never a raw second, so a re-timed script
// moves the beats with it.
import { asset, clamp, clear, ease, frame, prog, px, RGB, rect, rnd, sprite, step, text } from "pap:engine";
import { E, S, SCENES } from "pap:timeline";

const ID = "quest";
const SC = SCENES.find((s) => s.id === ID);
const GROUND = 148;
// the beats: the three stars land evenly across cue c02, the first a little after it starts
const T0 = S("c02") + 0.4;
const GAP = (E("c02") - T0) / 3.5;
const LANDS = [0, 1, 2].map((i) => T0 + i * GAP);

// what never changes is worked out once, at load time (draw must stay well under 250 ms)
const STARS = Array.from({ length: 36 }, (_, i) => [
  Math.floor(rnd(i * 3 + 1) * 320),
  Math.floor(rnd(i * 3 + 2) * 110),
]);
const TILES = asset("tiles") ? [frame("tiles", "ground-top"), frame("tiles", "ground")] : null;

function backdrop(t) {
  clear();
  for (const [i, [x, y]] of STARS.entries()) if ((Math.floor(t * 2) + i) % 9) px(x, y, RGB.q);
  sprite(frame("moon", "moon"), 268, 14);
  if (TILES)
    for (let x = 0; x < 320; x += 16) {
      sprite(TILES[0], x, GROUND);
      sprite(TILES[1], x, GROUND + 16);
    }
  else rect(0, GROUND, 320, 32, "K");
}

export function draw(t) {
  backdrop(t);
  // the hero breathes: idle0/idle1 every half second, feet on the ground
  const breath = Math.floor((t - SC.from) * 2) % 2;
  sprite(frame("hero", breath ? "idle1" : "idle0"), 60, GROUND - 24);
  let got = 0;
  LANDS.forEach((at, i) => {
    const k = prog(t, at - 0.5, at);
    if (k <= 0) return;
    // each star falls from above the frame and settles in its slot, whole pixels only
    const x = 128 + i * 32;
    const y = step(-16 + (64 - -16) * ease(k));
    sprite(frame("items", "star"), x, y);
    if (k >= 1) got++;
  });
  // one short text in the scene: the counter, top right, clear of the caption zone (it ends above y = 146)
  text(`${got}/3`, 304, 8, { align: "right", colour: "B" });
  // a flash ring on the slot just filled, for 0.2 s
  for (const at of LANDS) {
    const f = clamp((t - at) / 0.2);
    if (f > 0 && f < 1) rect(124 + LANDS.indexOf(at) * 32, 60, 20, 1, "B", 1 - f);
  }
}

// the sounds come from the same beats as the motion: a coin as each star lands
export function sfxEvents() {
  return LANDS.map((at) => ({ t: at, type: "coin" }));
}
