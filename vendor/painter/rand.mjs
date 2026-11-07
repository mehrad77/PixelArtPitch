/**
 * A seeded PRNG (mulberry32): the same seed always gives the same sequence, so a painted sprite is reproducible.
 * Returns a function yielding floats in [0, 1), with helpers for ranges and picks.
 */
export function rng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** a float in [a, b) */
  next.range = (a, b) => a + (b - a) * next();
  /** an integer in [a, b] */
  next.int = (a, b) => a + Math.floor((b - a + 1) * next());
  /** one item of a list */
  next.pick = (list) => list[Math.floor(list.length * next())];
  /** true with probability p */
  next.chance = (p) => next() < p;
  return next;
}
