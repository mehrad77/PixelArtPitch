// The code-scene kit (v0.5.1): walk() steps with the distance and faces its travel, flag() flies a logo's big frame,
// slots() numbers and fills a counted list, and the probe check catches a hand-rolled glide.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEngine } from "../src/core.ts";
import { withKit } from "../src/kit.ts";
import { type CodeProbe, lintCodeProbes } from "../src/lints.ts";
import { ASSETS, COLOURS, libAsset, SKY } from "./helpers.ts";

const solid = (w: number, h: number, c: string) => Array.from({ length: h }, () => c.repeat(w));
function kit(facing: Record<string, "left" | "right"> = { runner: "right" }) {
  const e = withKit(
    createEngine({
      colours: COLOURS,
      sky: SKY,
      assets: new Map([
        ...ASSETS,
        ["runner", libAsset("gamer").grid],
        ["logo", { icon: solid(16, 16, "O"), big: solid(32, 32, "r") }],
        ["small", { icon: solid(16, 16, "O") }],
      ]),
      fontAssets: ["font"],
      facing,
    }),
  );
  const calls: { frame: string; flip: boolean; x: number }[] = [];
  let last = "";
  const frame = e.frame;
  const sprite = e.sprite;
  const k = withKit({
    ...e,
    frame: (n: string, f: string, fb?: [number, number]) => {
      last = f;
      return frame(n, f, fb);
    },
    sprite: (rows: any, x: number, y: number, o: any = {}) => {
      calls.push({ frame: last, flip: !!o.flip, x });
      return sprite(rows, x, y, o);
    },
  });
  return { e, k, calls };
}

test("walk: idle before and after, run0-run3 stepping with the distance, facing its travel", () => {
  const { k, calls } = kit();
  const at = (t: number, o = {}) => {
    calls.length = 0;
    const r = k.walk("runner", { x0: 40, x1: 200, t0: 1, t1: 6, t, ...o });
    return { ...calls[0], ...r };
  };
  assert.match(at(0.5).frame, /^idle/);
  assert.equal(at(0.5).x, 40);
  assert.match(at(7).frame, /^idle/);
  assert.equal(at(7).x, 200);
  const runs = new Set<string>();
  for (let t = 1.05; t < 6; t += 1 / 30) runs.add(at(t).frame);
  assert.deepEqual([...runs].sort(), ["run0", "run1", "run2", "run3"]);
  // one step per 4 px (32/fps at fps 8): the frame follows the distance, not the clock
  assert.equal(at(1 + 5 * (6 / 160)).frame, "run1");
  assert.equal(at(3).flip, false, "right-facing art walking right is drawn as is");
  assert.equal(at(3, { x0: 200, x1: 40 }).flip, true, "walking left it turns");
  assert.equal(at(7, { x0: 200, x1: 40 }).flip, true, "and stays turned the way it went");
  assert.equal(at(7, { face: "right", x0: 200, x1: 40 }).flip, false, "face: turns it after");
  // the library's NPC (no run cycle, art looking left) steps on its idle frames
  const npc = kit({});
  npc.k.walk("hero", { x0: 40, x1: 200, t0: 1, t1: 6, t: 3 });
  assert.match(npc.calls[0].frame, /^idle/);
  assert.equal(npc.calls[0].flip, true);
});

test("flag: the cloth flies the logo's big frame, else its icon, and rises with up", () => {
  const { e, k } = kit();
  e.clear();
  const big = k.flag("logo", { x: 200, t: 0 });
  assert.deepEqual([big.w, big.h], [40, 40]);
  const red = e.RGB.r;
  const at = (x: number, y: number) => [...e.buf.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  assert.deepEqual(at(big.x + 4 + 16, big.y + 4 + 16), red, "the big frame is drawn on the cloth");
  assert.deepEqual(at(big.x + 3, big.y + 10), [...e.RGB.P], "a 1 px light ring round the logo");
  const small = k.flag("small", { x: 200, t: 0 });
  assert.deepEqual([small.w, small.h], [24, 24]);
  const low = k.flag("logo", { x: 200, t: 0, up: 0 });
  assert.ok(low.y > big.y + 40, "up: 0 is the foot of the pole");
});

test("slots: numbered 1..n, filled by count or by time with a flash", () => {
  const { e, k } = kit();
  const texts: string[] = [];
  const text = e.text;
  const k2 = withKit({
    ...e,
    text: (s: string, x: number, y: number, o?: any) => {
      texts.push(s);
      return text(s, x, y, o);
    },
  });
  const row = k2.slots(3, { x: 40, y: 40, w: 60, h: 40, filled: [2, 3, 4], t: 3.1 });
  assert.deepEqual(texts, ["1", "2", "3"]);
  assert.deepEqual(
    row.map((s) => [s.x, s.on]),
    [
      [40, true],
      [108, true],
      [176, false],
    ],
  );
  assert.equal(k.slots(4, { x: 0, y: 0, filled: 1, t: 0 }).filter((s) => s.on).length, 1);
});

test("walk-glide: a walker that moves on idle frames is flagged, walk() and a still one are not", () => {
  const probe = (xs: number[], frames: string[]): CodeProbe[] =>
    xs.map((x, i) => ({
      t: i,
      ms: 1,
      boxes: [{ kind: "sprite", name: "runner", frame: frames[i % frames.length], x, y: 124 }],
    }));
  const glide = lintCodeProbes("s", probe([40, 60, 80], ["idle0", "idle1"]), { walkers: ["runner"] });
  assert.equal(glide.length, 1);
  assert.equal(glide[0].rule, "walk-glide");
  assert.match(glide[0].fix, /walk\("runner"/);
  assert.equal(lintCodeProbes("s", probe([40, 60, 80], ["run0", "run2"]), { walkers: ["runner"] }).length, 0);
  assert.equal(lintCodeProbes("s", probe([40, 40, 41], ["idle0"]), { walkers: ["runner"] }).length, 0);
  assert.equal(lintCodeProbes("s", probe([40, 60, 80], ["idle0"]), { walkers: [] }).length, 0, "an NPC may glide");
});
