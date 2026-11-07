// One shared legend for every sprite in the video: letter -> #rrggbb.
// The night colours come from shab.boo's tokens (packages/kit/src/styles/tokens.css); a few extras cover the
// characters' clothes and hair and a light sky blue.
export const PALETTE = {
  k: ["#090c0a", "ink: outlines, deepest shadow"],
  K: ["#161d18", "ink-3: the night ground/background tone"],
  l: ["#24302a", "line: dark green-grey"],
  e: ["#3c463f", "limb: mid dark grey-green"],
  P: ["#e6e4da", "paper: off-white highlight, text"],
  p: ["#9a9d93", "paper-dim: light grey"],
  q: ["#666b63", "paper-off: mid grey"],
  g: ["#1f5a3d", "accent: dark green"],
  G: ["#2c7a53", "accent-strong: green"],
  T: ["#6cbf8e", "accent-text: light green"],
  O: ["#ff6b3d", "signal: orange highlight (tiny doses)"],
  B: ["#d6a642", "brass: gold / yellow"],
  S: ["#e0a985", "skin light"],
  s: ["#b9805f", "skin shade"],
  z: ["#8a5a42", "skin deep shade"],
  H: ["#d8d68f", "straw: blond hair light"],
  h: ["#a3a35a", "straw shade"],
  j: ["#7a7a3c", "straw deep"],
  n: ["#5c4030", "umber: dark brown"],
  c: ["#9a5a2c", "chestnut: brown"],
  A: ["#2a211c", "black-brown hair"],
  a: ["#4a3a30", "dark hair highlight"],
  M: ["#b8e6d2", "mint"],
  m: ["#8fc4ae", "mint shade"],
  D: ["#4a6fae", "denim"],
  d: ["#304f86", "denim shade"],
  L: ["#7aa0dc", "denim light"],
  W: ["#c9c6bc", "light grey"],
  w: ["#96938a", "light grey shade"],
  X: ["#2f8a90", "teal"],
  x: ["#1f5f66", "teal shade"],
  F: ["#2a2f33", "near-black (lit)"],
  f: ["#1a1d20", "near-black shade"],
  C: ["#4fbfcf", "turquoise"],
  E: ["#86d8e2", "pale turquoise"],
  Q: ["#a3e0ff", "light sky blue"],
  U: ["#5b4fd0", "ultramarine / violet-blue"],
  I: ["#2c3f8a", "indigo"],
  N: ["#1b2240", "navy"],
  Y: ["#4a5563", "slate grey"],
  R: ["#8e2f4a", "wine red"],
  r: ["#d9475a", "bright red (hearts)"],
  V: ["#b996e6", "violet"],
};

export const COLOURS = Object.fromEntries(Object.entries(PALETTE).map(([k, [hex]]) => [k, hex]));
export const SKY = "#0f1411"; // ink-2, the night sky the sprites stand on
export const hexToRgb = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
export const RGB = Object.fromEntries(Object.entries(COLOURS).map(([k, h]) => [k, hexToRgb(h)]));
