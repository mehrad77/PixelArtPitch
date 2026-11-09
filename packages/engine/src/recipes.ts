// Recipes: a closed menu of ready-made beats. An agent picks one and fills a few params; expand() turns it into layers
// (plus camera shakes, hit-stops and sounds) that compileDecl() validates and draws like hand-written layers.
// Every time param is a TimeExpr resolved through at(); a recipe called with only its required params looks finished.
// Runs inside the render sandbox's import graph: no zod, no eval, no Math.random.
import type { LayerT } from "@pap/schema";
import { plainText } from "./core.ts";
import { type At, checkSpec, type DeclIssue } from "./decl-check.ts";
import { GROUND, hudSlot, type PSpec, walkPlan } from "./decl-spec.ts";

export type RecipeOut = {
  layers: LayerT[];
  camera?: {
    keys?: Record<string, { t: number | string; v: number; ease?: string }[]>;
    shakes?: { at: number | string; amp: number; dur: number }[];
  };
  sfx?: { t: number | string; type: string }[];
  /** hit-stops: world motion freezes for dur seconds */
  pauses?: { at: number | string; dur: number }[];
};
export type RecipeCtx = {
  at: At;
  path: string;
  issues: DeclIssue[];
  scene: { id: string; from: number; to: number; cues: string[] };
  /** layer ids are `${prefix}_name` */
  prefix: string;
  /** layers expanded by earlier recipes in this scene (a recipe may find an actor here and add behaviours to it) */
  layers: LayerT[];
};
/** what a recipe sees: its context plus small helpers */
export type H = RecipeCtx & {
  from: number;
  to: number;
  /** the first moment worth animating: after the dissolve into the scene */
  t0: number;
  id: (name: string) => string;
  /** [start, end] of the scene's i-th cue, or null */
  cue: (i: number) => [number, number] | null;
  /** an actor layer from an earlier recipe (by id, else the last one) */
  actor: (id?: string) => LayerT | null;
  /** the last actor an earlier recipe drew with this asset, so a recipe reuses it instead of drawing a twin */
  same: (asset: string) => LayerT | null;
};
export type RParam = PSpec & {
  /** default computed from the scene (times, positions); `defDoc` says what it is */
  def?: (h: H, p: Record<string, any>) => unknown;
  defDoc?: string;
  /** an asset slot: the default asset id and the library asset it usually points at */
  lib?: string;
  /** it changes what is on screen (who, what they do, what stands beside them): the Director's menu lists it */
  screen?: boolean;
};
export type Recipe = {
  id: string;
  title: string;
  description: string;
  params: Record<string, RParam>;
  minDurationSec: number;
  /** what its default times hang off */
  anchors: string[];
  /** sounds it emits */
  sfx: string[];
  expand: (p: Record<string, any>, h: H) => RecipeOut;
};

const G = GROUND;
const L = (id: string, kind: LayerT["kind"], props: Record<string, unknown>, more: Partial<LayerT> = {}): LayerT => ({
  id,
  kind,
  z: 0,
  space: "world",
  props,
  ...more,
});
const B = (kind: string, at: number | undefined, params: Record<string, unknown> = {}, until?: number) =>
  ({ kind, at, until, params }) as NonNullable<LayerT["behaviors"]>[number];

/** the moment a walk_in-style actor stops, from its walk behaviour */
function arrival(l: LayerT): { t: number; x: number } | null {
  const w = l.behaviors?.find((b) => b.kind === "walk");
  if (!w || typeof w.at !== "number") return null;
  const p = { speed: 30, decel: 0.3, ...w.params } as { to: number; speed: number; decel: number };
  const plan = walkPlan(Number(l.props.x ?? 0), p);
  return { t: w.at + plan.dur, x: p.to };
}

/** where an actor stands once its walks are done (its x when it never walks) */
function standX(l: LayerT): number {
  let x = Number(l.props.x ?? 0);
  for (const b of l.behaviors ?? [])
    if (b.kind === "walk" && typeof (b.params as any)?.to === "number") x = (b.params as any).to;
  return x;
}
/** when an actor's last walk ends (or -Infinity) */
function walkEnd(l: LayerT): number {
  let x = Number(l.props.x ?? 0);
  let end = Number.NEGATIVE_INFINITY;
  for (const b of l.behaviors ?? []) {
    if (b.kind !== "walk" || typeof b.at !== "number") continue;
    const p = { speed: 30, decel: 0.3, ...b.params } as { to: number; speed: number; decel: number };
    end = b.at + walkPlan(x, p).dur;
    x = p.to;
  }
  return end;
}
/** add state keys to a reused actor: its own keys from `from` on give way to the new ones */
function mergeState(l: LayerT, from: number, add: { t: number; v: string }[]) {
  const old = ((l.keys?.state ?? []) as { t: number | string; v: string }[]).filter(
    (k) => typeof k.t !== "number" || k.t < from,
  );
  const lastOld = old[old.length - 1];
  // a leading auto key: the layer's own motion (its walk's run) shows until the first forced state
  const bridge = lastOld?.v !== "auto" && add.length ? [{ t: from, v: "auto" }] : [];
  l.keys = { ...(l.keys ?? {}), state: [...old, ...bridge, ...add] as any };
}
/** a walk speed inside the walk behaviour's range (a reused hero far away just arrives a little late) */
const walkSpeed = (v: number) => Math.max(10, Math.min(200, v));
/** the asset height the library characters share: a recipe keeps props clear of a 16x24 hero's head */
const HERO_H = 24;
const second: RParam = {
  t: "bool",
  d: false,
  doc: "true: draw a second character even when an earlier recipe in this scene already has one with this asset",
};

const asset = (d: string, lib: string, doc: string): RParam => ({ t: "str", d, lib, doc });
/** a backdrop's time of day: auto follows the video's canvas.time */
const SKY_PARAM: RParam = {
  t: "enum",
  of: ["auto", "night", "dusk", "day"],
  d: "auto",
  doc: "the sky's time of day: auto follows the video (canvas.time); day is a blue sky, sun and clouds, dusk an amber ramp, a low sun and the first stars",
};
/** an override of the asset's own facing (its asset.json says which way it looks) */
const FACES: RParam = {
  t: "enum",
  of: ["right", "left"],
  doc: "which way the art looks; leave it out: the asset says (drawn heroes right, library NPCs left)",
};
const onScreen = (p: RParam): RParam => ({ ...p, screen: true });

/** the small props a recipe may stand beside a character or on the ground (library `props-small`, 16 x 16) */
export const SMALL_PROPS = ["lantern", "candle", "campfire", "book", "book-open", "rock", "tree-stump"] as const;
const SMALL_FRAME: Record<string, string> = {
  lantern: "lantern-lit",
  candle: "candle",
  campfire: "campfire0",
  book: "book-closed",
  "book-open": "book-open",
  rock: "rock",
  "tree-stump": "tree-stump",
};
/** a warm glow round a small prop's flame (the `glow` fx, breathing by 1 px) */
const glowAt = (id: string, x: number, y: number): LayerT =>
  L(id, "fx", { fx: "glow", x, y, size: 16, pulse: 1, period: 1.8 }, { z: -30 });
/**
 * A decor entry: a street prop from `props` (lamp, bush, signpost) or a small prop from `props-small` (a lantern, a
 * candle, a campfire…); `glow: true` lights a small prop with the `glow` fx.
 */
function decorLayers(p: Record<string, any>, h: H, fix: string): LayerT[] {
  const out: LayerT[] = [];
  (p.decor as any[]).forEach((d, i) => {
    if (!d || typeof d.frame !== "string" || typeof d.x !== "number") {
      h.issues.push({ path: `${h.path}.params.decor[${i}]`, message: "decor needs frame and x", fix });
      return;
    }
    const small = SMALL_FRAME[d.frame];
    if (d.glow && !small) {
      h.issues.push({
        path: `${h.path}.params.decor[${i}].glow`,
        message: `a ${d.frame} doesn't glow`,
        fix: `glow a small prop: ${SMALL_PROPS.join(", ")} (e.g. { "frame": "lantern", "x": ${d.x}, "glow": true })`,
      });
      return;
    }
    out.push(
      L(
        h.id(`decor${i}`),
        "sprite",
        { asset: small ? "props-small" : "props", frame: small ?? d.frame, x: d.x, y: G, anchor: "bottom" },
        { z: -40 },
      ),
    );
    if (d.glow) out.push(glowAt(h.id(`decor${i}_glow`), d.x, G - 9));
  });
  return out;
}
/** a small prop standing beside a character (`prop: { frame, glow? }`), or an issue */
function propBeside(p: Record<string, any>, h: H, x: number, side: number): LayerT[] {
  const pr = p.prop;
  if (!pr) return [];
  const small = typeof pr.frame === "string" ? SMALL_FRAME[pr.frame] : undefined;
  if (!small) {
    h.issues.push({
      path: `${h.path}.params.prop.frame`,
      message: `no small prop ${JSON.stringify(pr.frame)}`,
      fix: `use one of: ${SMALL_PROPS.join(", ")}`,
    });
    return [];
  }
  const px = Math.round(x + side * 14);
  return [
    L(h.id("prop"), "sprite", { asset: "props-small", frame: small, x: px, y: G, anchor: "bottom" }, { z: 9 }),
    ...(pr.glow ? [glowAt(h.id("prop_glow"), px, G - 9)] : []),
  ];
}
/** a character's name tag: the plain box (`nameTag: "box"`), or a painted sign board above the head ("sign") */
function tagFor(p: Record<string, any>, h: H, to: string, dy: number, more: NonNullable<LayerT["behaviors"]> = []) {
  if (!p.label) return [];
  const attach = B("attach", undefined, { to, dx: 0, dy });
  return [
    p.nameTag === "sign"
      ? L(
          h.id("tag"),
          "widget",
          { widget: "label", text: p.label, mount: "none" },
          { z: 30, behaviors: [{ ...attach, params: { to, dx: 0, dy: dy - 4 } }, ...more] },
        )
      : L(h.id("tag"), "widget", { widget: "nameTag", label: p.label }, { z: 30, behaviors: [attach, ...more] }),
  ];
}
const nameTag: RParam = onScreen({
  t: "enum",
  of: ["box", "sign"],
  d: "box",
  doc: 'how the label is drawn: "box" a small name tag, "sign" a painted sign board (the label widget)',
});
/** an actor an earlier recipe in this scene drew, by its asset id ("owl", "hero") or its layer id */
function actorFor(h: H, who: string): LayerT | null {
  return h.same(who) ?? h.actor(who) ?? null;
}
const time = (defDoc: string, def: RParam["def"], doc: string): RParam => ({ t: "time", def, defDoc, doc });

// ---------------------------------------------------------------- the menu
export const RECIPES: Recipe[] = [
  {
    id: "backdrop_night",
    title: "Night backdrop",
    description:
      "The sky for the video's time of day (night: twinkling stars and the moon; dusk: an amber ramp, a low sun, the first stars; day: blue, a sun and clouds), parallax skyline, ground tiles and a lamp and a bush.",
    minDurationSec: 0,
    anchors: [],
    sfx: [],
    params: {
      sky: SKY_PARAM,
      stars: { t: "int", d: 70, min: 0, max: 200, doc: "how many stars" },
      moon: { t: "bool", d: true, doc: "draw the moon" },
      skyline: { t: "bool", d: true, doc: "draw the city skyline" },
      ground: { t: "bool", d: true, doc: "draw the ground tiles" },
      decor: {
        t: "list",
        d: [
          { frame: "lamp", x: 24 },
          { frame: "bush", x: 290 },
        ],
        doc: "props on the ground: [{ frame: lamp|bush|signpost|lantern|candle|campfire, x, glow? }]; glow: true lights a lantern, candle or campfire",
        screen: true,
      },
      gaps: { t: "list", d: [], doc: "[[fromX, toX]] holes in the ground" },
    },
    expand(p, h) {
      const layers: LayerT[] = [
        L(
          h.id("sky"),
          "backdrop",
          { stars: p.stars, moon: p.moon, skyline: p.skyline, ...(p.sky !== "auto" ? { time: p.sky } : {}) },
          { z: -100, space: "screen" },
        ),
      ];
      if (p.ground) layers.push(L(h.id("ground"), "tiled", { gaps: p.gaps }, { z: -50 }));
      layers.push(...decorLayers(p, h, '{ "frame": "lamp", "x": 24 }'));
      return { layers };
    },
  },
  {
    id: "backdrop_rooftop",
    title: "Rooftop backdrop",
    description:
      "The sky over the city from up high (night, dusk or day, as the video's), a lower skyline and a slate roof whose ridge is the ground line, with brick chimneys.",
    minDurationSec: 0,
    anchors: [],
    sfx: [],
    params: {
      sky: SKY_PARAM,
      stars: { t: "int", d: 70, min: 0, max: 200, doc: "how many stars" },
      moon: { t: "bool", d: true, doc: "draw the moon" },
      skyline: { t: "bool", d: true, doc: "draw the city skyline beyond the roof" },
      chimneys: {
        t: "list",
        d: [252],
        doc: "world x of each chimney's left edge (14 px wide, 22 px tall); [] for none",
        screen: true,
      },
      decor: {
        t: "list",
        d: [],
        doc: 'props on the roof: [{ frame: lantern|candle|signpost, x, glow? }]; a lit lantern is { "frame": "lantern", "x": 136, "glow": true }',
        screen: true,
      },
    },
    expand(p, h) {
      const layers: LayerT[] = [
        L(
          h.id("sky"),
          "backdrop",
          {
            style: "rooftop",
            stars: p.stars,
            moon: p.moon,
            skyline: p.skyline,
            chimneys: p.chimneys,
            ...(p.sky !== "auto" ? { time: p.sky } : {}),
          },
          { z: -100, space: "screen" },
        ),
      ];
      layers.push(...decorLayers(p, h, '{ "frame": "lantern", "x": 136, "glow": true }'));
      return { layers };
    },
  },
  {
    id: "title_card",
    title: "Title card",
    description: "A big title drops in and slams down with a shake and a ring; an optional subtitle fades in under it.",
    minDurationSec: 1.5,
    anchors: ["scene start"],
    sfx: ["bump", "select"],
    params: {
      title: { t: "str", req: true, doc: "1-2 words, about 12 characters" },
      subtitle: { t: "str", d: "", doc: "one short line under the title" },
      at: time("t0 + 0.1 s", (h) => h.t0 + 0.1, "when the title starts to drop"),
      colour: { t: "colour", d: "B", doc: "title colour" },
      y: { t: "num", d: 34, min: 4, max: 90, doc: "title top y" },
    },
    expand(p, h) {
      const land = p.at + 0.45;
      return {
        layers: [
          L(
            h.id("title"),
            "text",
            { text: p.title, x: 160, y: p.y, scale: 3, fit: true, colour: p.colour },
            {
              z: 40,
              space: "screen",
              behaviors: [
                B("appear", p.at, { style: "drop", dur: 0.45, dist: 70 }),
                B("bob", land + 0.6, { amp: 1, period: 4 }),
              ],
            },
          ),
          L(
            h.id("ring"),
            "fx",
            { fx: "ring", x: 160, y: p.y + 12, at: land, colour: p.colour },
            { z: 39, space: "screen" },
          ),
          ...(p.subtitle
            ? [
                L(
                  h.id("subtitle"),
                  "text",
                  { text: p.subtitle, x: 160, y: p.y + 34, colour: "P" },
                  {
                    z: 40,
                    space: "screen",
                    behaviors: [B("appear", land + 0.25, { style: "slideUp", dur: 0.3, dist: 6 })],
                  },
                ),
              ]
            : []),
        ],
        camera: { shakes: [{ at: land, amp: 2, dur: 0.25 }] },
        sfx: [{ t: land, type: "bump" }, ...(p.subtitle ? [{ t: land + 0.25, type: "select" }] : [])],
      };
    },
  },
  {
    id: "walk_in",
    title: "Walk in",
    description:
      "The hero walks in from the edge and stops at x (whole pixels, run cycle, footstep dust), then waves; then: sit sits down there, and prop stands a small prop (a glowing lantern) beside them.",
    minDurationSec: 2,
    anchors: ["scene start", "arrive"],
    sfx: [],
    params: {
      hero: onScreen(asset("hero", "lib:mentor-ai@1", "character asset id")),
      faces: FACES,
      x: { t: "num", d: 120, min: 16, max: 304, doc: "where the hero stops (centre x)" },
      from: { t: "enum", of: ["left", "right"], d: "left", doc: "which edge they come from" },
      speed: { t: "num", d: 30, min: 10, max: 80, doc: "walking speed in px/s" },
      at: time("scene start", (h) => h.from, "when the walk starts"),
      arrive: time(
        "scene start + 60% of the scene, at most 3 s",
        (h, p) => p.at + Math.min(3, Math.max(1, (h.to - p.at) * 0.6)),
        "when the hero stops",
      ),
      wave: { t: "bool", d: true, doc: "wave after stopping" },
      // biome-ignore lint/suspicious/noThenProperty: a recipe param in the project's JSON, never awaited
      then: onScreen({
        t: "enum",
        of: ["stand", "sit"],
        d: "stand",
        doc: "after stopping: stand, or sit down there (the sit behaviour, perch frames)",
      }),
      prop: onScreen({
        t: "obj",
        doc: 'a small prop beside them, on the side they face: { "frame": lantern|candle|campfire|book|book-open|rock|tree-stump, "glow"?: true }',
      }),
      label: onScreen({ t: "str", d: "", doc: "optional name tag above the head (1-2 words)" }),
      nameTag,
      scale: onScreen({
        t: "int",
        d: 1,
        min: 1,
        max: 3,
        doc: "how big the hero is drawn: 2 is twice the size (whole pixels)",
      }),
      second,
    },
    expand(p, h) {
      const again = p.second ? null : h.same(p.hero);
      // after stopping: sit down where they stand (after the wave, when they wave)
      const sitAt = p.arrive + (p.wave ? 1.2 : 0.1);
      const sit = p.then === "sit" ? [B("sit", sitAt, { land: 0 })] : [];
      if (again) {
        if (p.scale > 1) again.props = { ...again.props, scale: p.scale };
        // the scene already has this hero: walk it on to x instead of drawing a twin
        const dur = Math.max(0.3, p.arrive - p.at);
        const decel = Math.min(0.3, dur / 2);
        const dist = Math.abs(p.x - standX(again));
        again.behaviors = [
          ...(again.behaviors ?? []),
          B("walk", p.at, { to: p.x, speed: walkSpeed(dist / Math.max(0.01, dur - decel / 2)), decel }),
        ];
        if (p.wave)
          mergeState(again, p.at, [
            { t: p.arrive + 0.3, v: "wave" },
            { t: p.arrive + 1.2, v: "auto" },
          ]);
        again.behaviors.push(...sit);
        const side = p.x >= standX(again) ? 1 : -1;
        return { layers: propBeside(p, h, p.x, side) };
      }
      const dir = p.from === "left" ? 1 : -1;
      const dur = Math.max(0.3, p.arrive - p.at);
      const decel = Math.min(0.3, dur / 2);
      const dist = p.speed * (dur - decel / 2);
      const x0 = Math.round(p.x - dir * dist);
      const id = h.id("hero");
      const keys: LayerT["keys"] = p.wave
        ? {
            state: [
              { t: p.at, v: "auto" },
              { t: p.arrive + 0.3, v: "wave" },
              { t: p.arrive + 1.2, v: "auto" },
            ],
          }
        : undefined;
      const layers: LayerT[] = [
        L(
          id,
          "actor",
          {
            asset: p.hero,
            x: x0,
            artFaces: p.faces,
            facing: dir > 0 ? "right" : "left",
            ...(p.scale > 1 ? { scale: p.scale } : {}),
          },
          {
            z: 10,
            keys,
            behaviors: [B("walk", p.at, { to: p.x, speed: dist / Math.max(0.01, dur - decel / 2), decel }), ...sit],
          },
        ),
      ];
      layers.push(...tagFor(p, h, id, -16 - 24 * p.scale), ...propBeside(p, h, p.x, dir));
      return { layers };
    },
  },
  {
    id: "block_bump",
    title: "Block bump",
    description:
      "The hero jumps and hits a ? block from below: bump, hit-stop, camera shake, the block turns used and a reward pops out.",
    minDurationSec: 1.5,
    anchors: ["walk_in arrival", "scene start"],
    sfx: ["jump", "bump", "coin", "land"],
    params: {
      actor: {
        t: "str",
        d: "",
        doc: "layer id of the actor that jumps (default: the last actor, e.g. walk_in's hero)",
      },
      hero: asset("hero", "lib:mentor-ai@1", "character asset, used only when the scene has no actor yet"),
      faces: FACES,
      x: {
        t: "num",
        def: (h, p) => (h.actor(p.actor) ? Math.round(arrival(h.actor(p.actor)!)?.x ?? 176) : 176),
        defDoc: "where the actor stops, else 176",
        min: 16,
        max: 304,
        doc: "block centre x",
      },
      y: { t: "num", d: 78, min: 40, max: 100, doc: "block top y (78 is one jump above the ground)" },
      hit: time(
        "actor arrival + 0.35 s, else t0 + 0.9 s",
        (h, p) => {
          const a = h.actor(p.actor);
          const arr = a ? arrival(a) : null;
          return arr ? arr.t + 0.35 : h.t0 + 0.9;
        },
        "when the head hits the block",
      ),
      reward: { t: "str", d: "star", doc: 'item frame that pops out ("" for none)' },
      rewardAsset: asset("items", "lib:items@1", "asset of the reward"),
      bricks: { t: "bool", d: true, doc: "a brick on each side of the block" },
    },
    expand(p, h) {
      const layers: LayerT[] = [];
      let actor = h.actor(p.actor);
      if (!actor) {
        actor = L(h.id("hero"), "actor", { asset: p.hero, x: p.x, artFaces: p.faces }, { z: 10 });
        layers.push(actor);
      }
      const feet = typeof actor.props.y === "number" ? actor.props.y : G;
      const height = Math.max(8, feet - 24 - (p.y + 16));
      const dur = 0.6;
      actor.behaviors = [...(actor.behaviors ?? []), B("jumpArc", p.hit - dur / 2, { height, dur })];
      const bx = Math.round(p.x - 8);
      layers.push(L(h.id("block"), "widget", { widget: "qblock", x: bx, y: p.y, hit: p.hit }, { z: 7 }));
      if (p.bricks)
        for (const [k, dx] of [
          [0, -16],
          [1, 16],
        ])
          layers.push(L(h.id(`brick${k}`), "sprite", { asset: "tiles", frame: "brick", x: bx + dx, y: p.y }, { z: 5 }));
      if (p.reward) {
        const ry = p.y - 14;
        layers.push(
          L(
            h.id("reward"),
            "sprite",
            { asset: p.rewardAsset, frame: p.reward, x: bx + 2, y: ry, outline: "k" },
            {
              z: 6,
              keys: {
                y: [
                  { t: p.hit, v: p.y + 2 },
                  { t: p.hit + 0.25, v: ry, ease: "outCubic" },
                ],
              },
              behaviors: [
                B("appear", p.hit, { style: "none" }),
                B("bob", p.hit + 0.25, { amp: 2, period: 1.2, hop: true }),
                B("sparkle", p.hit + 0.2, { colour: "B" }),
              ],
            },
          ),
        );
      }
      return {
        layers,
        camera: { shakes: [{ at: p.hit, amp: 2, dur: 0.25 }] },
        pauses: [{ at: p.hit, dur: 0.06 }],
        sfx: p.reward ? [{ t: p.hit + 0.08, type: "coin" }] : [],
      };
    },
  },
  {
    id: "item_collect",
    title: "Item collect",
    description:
      "Items pop up one by one (or lie on the ground for a walking hero) and fly on arcs into HUD slots, each landing with a coin and a tick.",
    minDurationSec: 2,
    anchors: ["scene start", "scene end"],
    sfx: ["coin"],
    params: {
      items: { t: "strs", d: ["star", "heart", "star"], doc: "item frames, one per slot, in order" },
      itemAsset: asset("items", "lib:items@1", "item asset"),
      hero: asset("hero", "lib:mentor-ai@1", "character asset"),
      faces: FACES,
      walk: {
        t: "bool",
        d: false,
        doc: "false: the hero stands and items pop above it; true: it walks over items on the ground",
      },
      x: {
        t: "num",
        d: 112,
        min: 16,
        max: 304,
        doc: "where the hero stands (walk: false); a hero already in the scene stays where it stopped",
      },
      at: time(
        "t0 + 0.1 s, or 0.2 s after a hero already in the scene stops walking",
        (h, p) => {
          const a = p.second ? null : h.same(p.hero);
          return Math.max(h.t0 + 0.1, a ? walkEnd(a) + 0.2 : 0);
        },
        "when the first item appears",
      ),
      until: time("scene end - 0.6 s", (h) => h.to - 0.6, "by when the last item must be in its slot"),
      hudX: { t: "num", d: 4, min: 0, max: 250, doc: "HUD left" },
      hudY: { t: "num", d: 4, min: 0, max: 120, doc: "HUD top" },
      slots: { t: "int", d: 0, min: 0, max: 8, doc: "slot count (0: one per item)" },
      filled: { t: "strs", d: [], doc: "frames already in the first slots (carried from an earlier scene)" },
      second,
    },
    expand(p, h) {
      const items: string[] = p.items;
      const n = items.length;
      if (!n) {
        h.issues.push({
          path: `${h.path}.params.items`,
          message: "no items",
          fix: 'e.g. "items": ["star", "heart", "star"]',
        });
        return { layers: [] };
      }
      const pre: string[] = p.filled;
      const slots = Math.max(p.slots || 0, pre.length + n);
      if (slots > 8)
        h.issues.push({
          path: `${h.path}.params.items`,
          message: `${slots} slots do not fit`,
          fix: "use at most 8 items including filled",
        });
      const fly = 0.5;
      const hover = 0.25;
      const span = Math.max(0.2, p.until - p.at - fly - hover);
      const gap = n > 1 ? Math.min(0.9, span / (n - 1)) : 0;
      // reuse the hero an earlier recipe (walk_in) drew with this asset rather than drawing a twin over it
      const again = p.second ? null : h.same(p.hero);
      const hero = again?.id ?? h.id("hero");
      const layers: LayerT[] = [];
      const hudItems: { asset: string; frame: string; at: number }[] = pre.map((f) => ({
        asset: p.itemAsset,
        frame: f,
        at: h.from,
      }));
      const heroB: NonNullable<LayerT["behaviors"]> = [];
      let heroX = again ? Math.round(standX(again)) : p.x;
      if (p.walk) {
        // items lie on the ground ahead; the hero walks over them at a speed that fits the window
        const x0 = again ? heroX : 24;
        const dir = x0 <= 160 ? 1 : -1;
        const [a, b] = again ? [x0 + dir * 40, dir > 0 ? 280 : 40] : [80, 240];
        const xs = items.map((_, i) => Math.round(a + (i * (b - a)) / Math.max(1, n - 1)));
        const stop = Math.max(16, Math.min(304, xs[n - 1] + dir * 30));
        const last = p.until - fly;
        const speed = Math.min(80, Math.max(20, Math.abs(xs[n - 1] - x0) / Math.max(0.3, last - p.at)));
        heroX = x0;
        heroB.push(B("walk", p.at, { to: stop, speed, decel: 0.3 }));
        items.forEach((f, i) => {
          const tp = p.at + Math.abs(xs[i] - x0) / speed;
          const slot = hudSlot(p.hudX, p.hudY, pre.length + i);
          layers.push(
            L(
              h.id(`item${i}`),
              "sprite",
              { asset: p.itemAsset, frame: f, x: xs[i] - 6, y: G - 14, outline: "k" },
              {
                z: 12,
                behaviors: [
                  B("bob", h.from, { amp: 2, period: 1.4, phase: i * 0.2, hop: true }, tp),
                  B("arc", tp, { toX: slot[0], toY: slot[1], screen: true, dur: fly, lift: 20, hide: true }),
                  B("sparkle", tp, { colour: "B" }),
                ],
              },
            ),
          );
          hudItems.push({ asset: p.itemAsset, frame: f, at: tp + fly });
        });
      } else {
        items.forEach((f, i) => {
          const tp = p.at + i * gap;
          const slot = hudSlot(p.hudX, p.hudY, pre.length + i);
          // the item pops out clear of the head: its bottom stays 2 px above the head at the top of the hop
          const hop = 6;
          const pop = G - HERO_H - hop - 2 - 12;
          const top = pop - 12;
          heroB.push(B("jumpArc", tp - 0.05, { height: hop, dur: 0.3, sfx: false, squash: false }));
          layers.push(
            L(
              h.id(`item${i}`),
              "sprite",
              { asset: p.itemAsset, frame: f, x: heroX - 6, y: top, outline: "k" },
              {
                z: 12,
                keys: {
                  y: [
                    { t: tp, v: pop },
                    { t: tp + hover, v: top, ease: "outCubic" },
                  ],
                },
                behaviors: [
                  B("appear", tp, { style: "none" }),
                  B("sparkle", tp, { colour: "B" }),
                  B("arc", tp + hover, { toX: slot[0], toY: slot[1], screen: true, dur: fly, lift: 18, hide: true }),
                ],
              },
            ),
          );
          hudItems.push({ asset: p.itemAsset, frame: f, at: tp + hover + fly });
        });
      }
      const done = hudItems[hudItems.length - 1].at;
      const wave = [
        { t: done + 0.1, v: "wave" },
        { t: done + 1.1, v: "auto" },
      ];
      if (again) {
        again.behaviors = [...(again.behaviors ?? []), ...heroB];
        mergeState(again, p.at - 0.1, p.walk ? [] : wave);
      } else
        layers.push(
          L(
            hero,
            "actor",
            { asset: p.hero, x: heroX, artFaces: p.faces },
            { z: 10, behaviors: heroB, ...(p.walk ? {} : { keys: { state: wave } }) },
          ),
        );
      layers.push(
        L(
          h.id("hud"),
          "widget",
          { widget: "hudSlots", x: p.hudX, y: p.hudY, slots, items: hudItems },
          { z: 60, space: "screen" },
        ),
      );
      return { layers };
    },
  },
  {
    id: "spawn_join",
    title: "Player joins",
    description:
      "A second character joins: drops in from the sky (a squash, dust and a small shake), walks in, or flies in (motion), and can then follow another actor; an optional banner announces them.",
    minDurationSec: 1.5,
    anchors: ["scene start"],
    sfx: ["fall", "land", "join"],
    params: {
      who: {
        t: "str",
        req: true,
        lib: "lib:mentor-gtm@1",
        doc: "character asset id: cast the newcomer (e.g. moth)",
        screen: true,
      },
      faces: FACES,
      facing: { t: "enum", of: ["right", "left"], d: "left", doc: "which way they look after landing" },
      x: { t: "num", d: 200, min: 16, max: 304, doc: "landing spot (centre x)" },
      at: time("t0 + 0.1 s", (h) => h.t0 + 0.1, "when they start falling"),
      motion: onScreen({
        t: "enum",
        of: ["drop", "walk", "fly"],
        d: "drop",
        doc: "how they arrive: drop from the sky, walk in from the edge, or fly in (the fly behaviour) and hover",
      }),
      from: { t: "enum", of: ["left", "right"], d: "right", doc: "walk or fly: which edge they come from" },
      follow: onScreen({
        t: "str",
        d: "",
        doc: 'after arriving, stay beside this actor (an asset id an earlier recipe drew, e.g. "hero" or "owl"), riding along as it moves',
      }),
      banner: onScreen({ t: "str", d: "", doc: '1-3 words announcing them ("" for none)' }),
      label: onScreen({ t: "str", d: "", doc: "optional name tag above the head" }),
      nameTag,
    },
    expand(p, h) {
      const id = h.id("who");
      const dir = p.from === "left" ? 1 : -1;
      const x0 = dir > 0 ? -20 : 340;
      // fly: in along a gentle arc to hover over x; walk: in from the edge; drop: down from the sky (the old landing)
      const flyY = 100;
      const flySpeed = 60;
      const arrive =
        p.motion === "fly"
          ? p.at + Math.abs(p.x - x0) / flySpeed + 0.4
          : p.motion === "walk"
            ? p.at + Math.max(0.6, Math.abs(p.x - x0) / 40)
            : p.at + 0.45;
      const land = arrive;
      const target = p.follow ? actorFor(h, p.follow) : null;
      if (p.follow && !target) {
        h.issues.push({
          path: `${h.path}.params.follow`,
          message: `no actor ${JSON.stringify(p.follow)} to follow in this scene`,
          fix: `follow an actor an earlier recipe draws (${
            h.layers
              .filter((l) => l.kind === "actor")
              .map((l) => String(l.props.asset))
              .join(", ") || "none yet: put walk_in first"
          }), or leave follow ""`,
        });
        return { layers: [] };
      }
      const follow = target
        ? [
            B("sit", arrive + 0.3, {
              on: target.id,
              dx: -dir * 24,
              dy: p.motion === "fly" ? -28 : 0,
              land: 0.5,
              lift: p.motion === "fly" ? 4 : 0,
              squash: false,
            }),
          ]
        : [];
      const actor =
        p.motion === "drop"
          ? L(
              id,
              "actor",
              { asset: p.who, x: p.x, artFaces: p.faces, facing: p.facing },
              {
                z: 11,
                keys: {
                  y: [
                    { t: p.at, v: -8 },
                    { t: land, v: G, ease: "in" },
                  ],
                  state: [
                    { t: p.at, v: "jump" },
                    { t: land, v: "auto" },
                  ],
                },
                behaviors: [
                  B("appear", p.at, { style: "none" }),
                  B("squash", land, { dur: 0.12 }),
                  B("dust", land, { n: 3 }),
                  ...follow,
                ],
              },
            )
          : p.motion === "walk"
            ? L(
                id,
                "actor",
                { asset: p.who, x: x0, artFaces: p.faces, facing: dir > 0 ? "right" : "left" },
                {
                  z: 11,
                  behaviors: [
                    B("walk", p.at, {
                      to: p.x,
                      speed: Math.abs(p.x - x0) / Math.max(0.3, arrive - p.at - 0.15),
                      decel: 0.3,
                    }),
                    ...follow,
                  ],
                },
              )
            : L(
                id,
                "actor",
                { asset: p.who, x: x0, y: flyY - 20, artFaces: p.faces, facing: dir > 0 ? "right" : "left" },
                {
                  z: 11,
                  behaviors: [
                    B(
                      "fly",
                      p.at,
                      {
                        path: [
                          [Math.round((x0 + p.x) / 2), flyY - 12],
                          [p.x, flyY],
                        ],
                        speed: flySpeed,
                        bob: 2,
                      },
                      follow.length ? arrive + 0.3 : undefined,
                    ),
                    ...follow,
                  ],
                },
              );
      const layers: LayerT[] = [actor];
      if (p.banner)
        layers.push(
          L(
            h.id("banner"),
            "widget",
            { widget: "banner", text: p.banner, at: land + 0.1, colour: "T", sfx: null },
            { z: 70, space: "screen" },
          ),
        );
      layers.push(...tagFor(p, h, id, -40, [B("appear", land + 0.2, { style: "pop" })]));
      if (p.motion !== "drop") return { layers, sfx: [{ t: land, type: "join" }] };
      return {
        layers,
        camera: { shakes: [{ at: land, amp: 1, dur: 0.2 }] },
        sfx: [
          { t: p.at, type: "fall" },
          { t: land, type: "land" },
          { t: land + 0.05, type: "join" },
        ],
      };
    },
  },
  {
    id: "toast",
    title: "Achievement toast",
    description:
      "A small panel slides in from the right with an icon, a title and an optional second line, then slides out.",
    minDurationSec: 1,
    anchors: ["scene start"],
    sfx: ["achieve"],
    params: {
      title: { t: "str", req: true, doc: "about 16 characters" },
      sub: { t: "str", d: "", doc: "about 20 characters" },
      icon: { t: "str", d: "star", doc: "icon frame" },
      iconAsset: asset("items", "lib:items@1", "icon asset"),
      at: time("t0 + 0.25 s", (h) => h.t0 + 0.25, "when it slides in"),
      dur: { t: "num", d: 2.4, min: 0.8, max: 8, doc: "seconds on screen" },
      colour: { t: "colour", d: "B", doc: "border and title colour" },
    },
    expand(p, h) {
      return {
        layers: [
          L(
            h.id("toast"),
            "widget",
            {
              widget: "toast",
              title: p.title,
              sub: p.sub,
              icon: p.icon,
              iconAsset: p.iconAsset,
              at: p.at,
              dur: p.dur,
              colour: p.colour,
            },
            { z: 70, space: "screen" },
          ),
        ],
      };
    },
  },
  {
    id: "banner",
    title: "Banner",
    description: "A big two-scale word panel slides down from the top, flashes, and leaves after a moment.",
    minDurationSec: 1,
    anchors: ["scene start"],
    sfx: ["achieve"],
    params: {
      text: { t: "str", req: true, doc: "1-3 words, about 12 characters" },
      at: time("t0 + 0.2 s", (h) => h.t0 + 0.2, "when it slides in"),
      colour: { t: "colour", d: "O", doc: "border and flash colour" },
      y: { t: "num", d: 34, min: 4, max: 110, doc: "top y" },
      dur: { t: "num", d: 1.7, min: 0.6, max: 8, doc: "seconds on screen" },
      sfx: { t: "sfx", d: "achieve", doc: "sound (null for none)" },
    },
    expand(p, h) {
      return {
        layers: [
          L(
            h.id("banner"),
            "widget",
            { widget: "banner", text: p.text, at: p.at, colour: p.colour, y: p.y, dur: p.dur, sfx: p.sfx },
            { z: 70, space: "screen" },
          ),
        ],
      };
    },
  },
  {
    id: "crowd_cheer",
    title: "Crowd cheer",
    description: "A small crowd stands on the ground and bursts into a cheer with sparkles over their heads.",
    minDurationSec: 1,
    anchors: ["scene start"],
    sfx: ["cheer"],
    params: {
      crowd: asset("crowd", "lib:gamers@1", "crowd asset (frames cheer0, cheer1)"),
      x: { t: "num", d: 16, min: -40, max: 300, doc: "left edge of the first group" },
      count: { t: "int", d: 1, min: 1, max: 4, doc: "groups side by side" },
      at: time("t0 + 0.45 s", (h) => h.t0 + 0.45, "when they start cheering"),
      sparkles: { t: "bool", d: true, doc: "sparkles over their heads" },
    },
    expand(p, h) {
      const layers: LayerT[] = [];
      for (let i = 0; i < p.count; i++) {
        const x = p.x + i * 52;
        layers.push(
          L(
            h.id(`calm${i}`),
            "sprite",
            { asset: p.crowd, frame: "cheer0", x, y: G, anchor: "topLeft" },
            { z: 8, show: [h.from, p.at] },
          ),
          L(
            h.id(`cheer${i}`),
            "sprite",
            { asset: p.crowd, frames: ["cheer0", "cheer1"], fps: 4, x, y: G - 16, outline: "k" },
            { z: 8, show: [p.at, h.to] },
          ),
        );
        if (p.sparkles)
          layers.push(
            L(
              h.id(`spark${i}`),
              "fx",
              { fx: "sparkle", x: x + 24, y: G - 26, at: p.at + 0.1, every: 0.45, colour: i % 2 ? "T" : "B", size: 14 },
              { z: 9 },
            ),
          );
      }
      // the calm crowd stands with feet on the ground too
      for (const l of layers) if (l.id.includes("_calm")) l.props.y = G - 16;
      return { layers, sfx: [{ t: p.at, type: "cheer" }] };
    },
  },
  {
    id: "flag_raise",
    title: "Flag raise",
    description:
      "A flagpole beside a castle: the flag climbs to the top, then a flash, fireworks, a shake and a fanfare.",
    minDurationSec: 2,
    anchors: ["scene start"],
    sfx: ["flagpole", "flag", "fanfare"],
    params: {
      x: { t: "num", d: 196, min: 8, max: 290, doc: "pole x" },
      at: time("t0 + 0.25 s", (h) => h.t0 + 0.25, "when the flag starts to climb"),
      dur: { t: "num", d: 1.6, min: 0.4, max: 5, doc: "climb time" },
      castle: { t: "bool", d: true, doc: "a castle right of the pole" },
      castleX: {
        t: "num",
        def: (_h, p) => p.x + 22,
        defDoc: "pole x + 22",
        min: -60,
        max: 320,
        doc: "castle left edge",
      },
      flagAsset: asset("props", "lib:props@1", "asset with flag0 and flag1"),
      fireworks: { t: "bool", d: true, doc: "flash and fireworks when it reaches the top" },
      hero: {
        t: "str",
        d: "",
        lib: "lib:mentor-ai@1",
        doc: 'character that walks to the pole and cheers ("" for none)',
      },
      faces: FACES,
      second,
    },
    expand(p, h) {
      const top = p.at + p.dur;
      const hero: LayerT[] = [];
      const again = p.hero && !p.second ? h.same(p.hero) : null;
      if (again) {
        // the hero is already in the scene: it walks on to the foot of the pole and cheers
        const stop = p.x - 12;
        const startT = Math.max(h.from, p.at - 1.6, walkEnd(again) + 0.1);
        const dist = Math.abs(stop - standX(again));
        again.behaviors = [
          ...(again.behaviors ?? []),
          B("walk", startT, { to: stop, speed: walkSpeed(dist / Math.max(0.3, p.at - startT - 0.15)), decel: 0.3 }),
          B("jumpArc", top + 0.05, { height: 14, dur: 0.45 }),
        ];
        mergeState(again, startT, [
          { t: top + 0.6, v: "wave" },
          { t: top + 1.6, v: "auto" },
        ]);
      } else if (p.hero) {
        // walks in from the left and reaches the foot of the pole as the flag starts to climb
        const stop = p.x - 12;
        const startT = Math.max(h.from, p.at - 1.6);
        const x0 = Math.round(stop - 40 * Math.max(0.4, p.at - startT));
        hero.push(
          L(
            h.id("hero"),
            "actor",
            { asset: p.hero, x: x0, artFaces: p.faces },
            {
              z: 10,
              keys: {
                state: [
                  { t: top + 0.6, v: "wave" },
                  { t: top + 1.6, v: "auto" },
                ],
              },
              behaviors: [
                B("walk", startT, { to: stop, speed: (stop - x0) / Math.max(0.3, p.at - startT - 0.15), decel: 0.3 }),
                B("jumpArc", top + 0.05, { height: 14, dur: 0.45 }),
              ],
            },
          ),
        );
      }
      const layers: LayerT[] = [
        L(
          h.id("pole"),
          "widget",
          { widget: "flagpole", x: p.x, asset: p.flagAsset, raise: p.at, dur: p.dur },
          { z: 6 },
        ),
      ];
      if (p.castle)
        layers.push(
          L(h.id("castle"), "sprite", { asset: "castle", frame: "castle", x: p.castleX, y: G - 56 }, { z: 4 }),
        );
      if (p.fireworks)
        layers.push(
          L(h.id("flash"), "fx", { fx: "flash", at: top, dur: 0.25, colour: "P" }, { z: 80, space: "screen" }),
          L(
            h.id("fireworks"),
            "fx",
            { fx: "fireworks", x: 160, y: 40, at: top, n: 10, w: 288, h: 56 },
            { z: 75, space: "screen" },
          ),
        );
      layers.push(...hero);
      return { layers, camera: { shakes: [{ at: top, amp: 3, dur: 0.3 }] } };
    },
  },
  {
    id: "end_card_loop",
    title: "End card",
    description:
      "Title drops in, PRESS START bounces in and pulses, a URL line fades up and can pixel-dissolve to a second URL; twinkles and a shooting star keep it alive.",
    minDurationSec: 2.5,
    anchors: ["scene start"],
    sfx: ["land", "start", "select"],
    params: {
      title: { t: "str", req: true, doc: "product name, about 12 characters" },
      press: { t: "str", d: "PRESS START", doc: "the call to action, 1-2 words" },
      url: { t: "str", d: "", doc: "a URL line (optional)" },
      url2: { t: "str", d: "", doc: "a second URL that replaces the first (optional)" },
      swapAfter: { t: "num", d: 4, min: 0.5, max: 60, doc: "seconds after the URL appears before it swaps to url2" },
      at: time("t0", (h) => h.t0, "when the title drops"),
      colour: { t: "colour", d: "B", doc: "title colour" },
      hero: {
        t: "str",
        d: "",
        lib: "lib:mentor-ai@1",
        doc: 'character that stands and waves under the card ("" for none)',
      },
      faces: FACES,
      second,
    },
    expand(p, h) {
      const land = p.at + 0.35;
      const press = p.at + 0.65;
      const urlAt = p.at + 1.3;
      const layers: LayerT[] = [
        L(
          h.id("twinkle"),
          "fx",
          { fx: "twinkle", x: 160, y: 50, w: 300, h: 90, n: 8, colour: "B" },
          { z: -90, space: "screen" },
        ),
        L(
          h.id("shooting"),
          "fx",
          { fx: "shootingStar", at: p.at + 2, every: 7, colour: "B" },
          { z: -90, space: "screen" },
        ),
        L(
          h.id("title"),
          "text",
          { text: p.title, x: 160, y: 22, scale: 3, fit: true, colour: p.colour },
          {
            z: 40,
            space: "screen",
            behaviors: [
              B("appear", p.at, { style: "drop", dur: 0.35, dist: 60 }),
              B("bob", land + 1, { amp: 1, period: 5 }),
            ],
          },
        ),
        L(h.id("ring"), "fx", { fx: "ring", x: 160, y: 34, at: land, colour: p.colour }, { z: 39, space: "screen" }),
        L(
          h.id("press"),
          "text",
          { text: p.press, x: 160, y: 66, scale: 2, colour: "O" },
          {
            z: 40,
            space: "screen",
            behaviors: [
              B("appear", press, { style: "drop", dur: 0.35, dist: 40 }),
              B("pulse", press + 0.5, { min: 0.6, period: 1.6 }),
            ],
          },
        ),
      ];
      const sfx: RecipeOut["sfx"] = [
        { t: land, type: "land" },
        { t: press + 0.35, type: "start" },
      ];
      if (p.url) {
        const swap = p.url2 ? urlAt + p.swapAfter : null;
        layers.push(
          L(
            h.id("url"),
            "text",
            { text: p.url, x: 160, y: 92, colour: "T" },
            {
              z: 40,
              space: "screen",
              behaviors: [
                B("appear", urlAt, { style: "slideUp", dur: 0.4, dist: 3 }),
                ...(swap !== null ? [B("dissolve", swap, { dir: "out", dur: 0.5 })] : []),
              ],
            },
          ),
        );
        if (swap !== null)
          layers.push(
            L(
              h.id("url2"),
              "text",
              { text: p.url2, x: 160, y: 92, colour: "T" },
              { z: 40, space: "screen", behaviors: [B("dissolve", swap, { dir: "in", dur: 0.5 })] },
            ),
          );
        sfx.push({ t: urlAt, type: "select" });
      }
      const again = p.hero && !p.second ? h.same(p.hero) : null;
      if (again) {
        const state: { t: number; v: string }[] = [];
        for (let t = press + 0.5; t < h.to; t += 6) state.push({ t, v: "wave" }, { t: t + 1.2, v: "auto" });
        mergeState(again, press + 0.5, state);
      } else if (p.hero) {
        const state: { t: number; v: string }[] = [];
        for (let t = press + 0.5; t < h.to; t += 6) state.push({ t, v: "wave" }, { t: t + 1.2, v: "auto" });
        layers.push(
          L(
            h.id("hero"),
            "actor",
            { asset: p.hero, x: 160, artFaces: p.faces },
            { z: 10, keys: state.length ? { state } : undefined },
          ),
        );
      }
      return { layers, camera: { shakes: [{ at: land, amp: 1, dur: 0.25 }] }, sfx };
    },
  },
];

export const RECIPE_MAP: Record<string, Recipe> = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

function helpers(ctx: RecipeCtx): H {
  const { from, to } = ctx.scene;
  return {
    ...ctx,
    from,
    to,
    t0: from > 0.001 ? from + 0.35 : from + 0.2,
    id: (name) => `${ctx.prefix}_${name}`,
    cue: (i) => {
      const c = ctx.scene.cues[i];
      if (!c) return null;
      try {
        return [ctx.at(`S(${c})`), ctx.at(`E(${c})`)];
      } catch {
        return null;
      }
    },
    actor: (id) => {
      const actors = ctx.layers.filter((l) => l.kind === "actor");
      return (id ? actors.find((l) => l.id === id) : actors[actors.length - 1]) ?? null;
    },
    same: (asset) => ctx.layers.findLast((l) => l.kind === "actor" && l.props.asset === asset) ?? null,
  };
}

/** validate params (with computed defaults) and expand; problems go to ctx.issues and return null */
export function expandRecipe(r: Recipe, params: Record<string, unknown>, ctx: RecipeCtx): RecipeOut | null {
  const h = helpers(ctx);
  const before = ctx.issues.length;
  const p = checkSpec(`${ctx.path}.params`, r.params, params, ctx.issues, ctx.at);
  if (ctx.issues.length > before) return null;
  // typographic dashes, quotes and spaces a writer model emits become the plain ones the font draws
  for (const [k, s] of Object.entries(r.params)) if (s.t === "str" && typeof p[k] === "string") p[k] = plainText(p[k]);
  for (const [k, s] of Object.entries(r.params)) if (p[k] === undefined && s.def) p[k] = s.def(h, p);
  const out = r.expand(p, h);
  return ctx.issues.length > before ? null : out;
}

/** a JSON-schema-like description of every recipe, for prompts and the UI */
export function recipeCatalog() {
  return RECIPES.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    minDurationSec: r.minDurationSec,
    anchors: r.anchors,
    sfx: r.sfx,
    params: {
      type: "object",
      additionalProperties: false,
      required: Object.entries(r.params)
        .filter(([, s]) => s.req)
        .map(([k]) => k),
      properties: Object.fromEntries(
        Object.entries(r.params).map(([k, s]) => [
          k,
          {
            type:
              {
                num: "number",
                int: "integer",
                str: "string",
                bool: "boolean",
                time: "TimeExpr",
                strs: "string[]",
                list: "array",
              }[s.t as string] ?? s.t,
            description: s.doc,
            ...(s.d !== undefined ? { default: s.d } : {}),
            ...(s.defDoc ? { defaultIs: s.defDoc } : {}),
            ...(s.min !== undefined ? { minimum: s.min, maximum: s.max } : {}),
            ...(s.of ? { enum: s.of } : {}),
            ...(s.lib ? { asset: s.lib } : {}),
            ...(s.screen ? { onScreen: true } : {}),
          },
        ]),
      ),
    },
  }));
}

/** param problems of one recipe use (unknown recipe, unknown params, wrong types, out of range) without expanding */
export function checkRecipeParams(id: string, params: Record<string, unknown>, at: At, path = "recipe"): DeclIssue[] {
  const r = RECIPE_MAP[id];
  if (!r)
    return [
      {
        path: `${path}.id`,
        message: `unknown recipe ${JSON.stringify(id)}`,
        fix: `use one of: ${RECIPES.map((x) => x.id).join(", ")}`,
      },
    ];
  const issues: DeclIssue[] = [];
  checkSpec(`${path}.params`, r.params, params, issues, at);
  return issues;
}
