// Declarative scenes: layers with keyframes and behaviours, and recipes that expand into layers.
// compileDecl() resolves every time expression to seconds (it runs where the timeline lives) and validates every prop
// against the closed vocabulary in decl-spec.ts; drawDecl() is a pure function of t over the compiled,
// JSON-serialisable result, so it can run in the render sandbox (no eval, no zod, no Math.random) or the browser.
import type { DeclSceneT, LayerT } from "@pap/schema";
import { clamp, type Engine, type Frames, lerp, type RGBT, type Rows, rnd } from "./core.ts";
import { type At, checkSpec, DeclError, type DeclIssue, timeOf } from "./decl-check.ts";
import {
  ACTOR_STATES,
  BEHAVIOR_SPECS,
  DECL_KINDS,
  EASES,
  easeFn,
  GROUND,
  hudSlot,
  hudWidth,
  KEYABLE,
  KIND_SPECS,
  SFX_TYPES,
  WIDGET_SPECS,
  walkPlan,
} from "./decl-spec.ts";
import { expandRecipe, RECIPE_MAP, RECIPES, type RecipeOut } from "./recipes.ts";

export { type At, checkSpec, DeclError, type DeclIssue, timeOf } from "./decl-check.ts";

export type CKey = { t: number; v: number | string | boolean; ease?: string };
export type CBehavior = { kind: string; at: number; until: number; p: Record<string, any> };
export type CLayer = {
  id: string;
  kind: string;
  z: number;
  space: "world" | "screen";
  show: [number, number] | null;
  props: Record<string, any>;
  keys: Record<string, CKey[]>;
  behaviors: CBehavior[];
  children: CLayer[];
};
export type CompiledScene = {
  id: string;
  from: number;
  to: number;
  layers: CLayer[];
  camera: { keys: Record<string, CKey[]>; shakes: { at: number; amp: number; dur: number }[] };
  /** hit-stops: world motion freezes for dur seconds from at */
  pauses: { at: number; dur: number }[];
  sfx: { t: number; type: string }[];
  /** asset ids the scene draws, so a lint can check the project provides them */
  assets: string[];
};

const SFX = new Set<string>(SFX_TYPES);

// ---------------------------------------------------------------- compile
type CompileCtx = { at: At; issues: DeclIssue[]; ids: Set<string>; from: number; to: number; assets: Set<string> };

function compileKeys(path: string, kind: string, keys: LayerT["keys"], c: CompileCtx): Record<string, CKey[]> {
  const out: Record<string, CKey[]> = {};
  if (!keys) return out;
  const allowed: Record<string, string> = { ...KEYABLE.common, ...(KEYABLE[kind] ?? {}) };
  for (const [prop, list] of Object.entries(keys)) {
    const p = `${path}.keys.${prop}`;
    const type = allowed[prop];
    if (!type) {
      c.issues.push({
        path: p,
        message: `"${prop}" cannot be keyframed on a ${kind}`,
        fix: `keyable here: ${Object.keys(allowed).join(", ")}`,
      });
      continue;
    }
    if (!Array.isArray(list) || !list.length) {
      c.issues.push({
        path: p,
        message: "expected a non-empty list of keys",
        fix: 'e.g. [{ "t": "S(c01)", "v": 0 }, { "t": "S(c01)+1", "v": 40, "ease": "out" }]',
      });
      continue;
    }
    const ks: CKey[] = [];
    list.forEach((k: any, i: number) => {
      const kp = `${p}[${i}]`;
      const t = timeOf(`${kp}.t`, k?.t, c.issues, c.at);
      let v = k?.v;
      const want = (ok: boolean, what: string, fix: string) => {
        if (!ok) c.issues.push({ path: `${kp}.v`, message: `expected ${what}, got ${JSON.stringify(v)}`, fix });
      };
      if (type === "num") want(typeof v === "number", "a number", "write a plain number");
      if (type === "bool") want(typeof v === "boolean", "true or false", "use true or false");
      if (type === "str") want(typeof v === "string", "text", 'write it in quotes, e.g. "wave"');
      if (kind === "actor" && prop === "state" && !(ACTOR_STATES as readonly string[]).includes(v)) {
        c.issues.push({
          path: `${kp}.v`,
          message: `unknown actor state ${JSON.stringify(v)}`,
          fix: `use one of: ${ACTOR_STATES.join(", ")}`,
        });
        v = "auto";
      }
      if (k?.ease !== undefined && !(EASES as readonly string[]).includes(k.ease))
        c.issues.push({
          path: `${kp}.ease`,
          message: `unknown ease ${JSON.stringify(k.ease)}`,
          fix: `use one of: ${EASES.join(", ")}`,
        });
      ks.push(k?.ease === undefined ? { t, v } : { t, v, ease: k.ease });
    });
    ks.sort((a, b) => a.t - b.t);
    out[prop] = ks;
  }
  return out;
}

function compileBehaviors(path: string, l: LayerT, c: CompileCtx, show: [number, number] | null): CBehavior[] {
  return (l.behaviors ?? []).map((b, i) => {
    const p = `${path}.behaviors[${i}]`;
    const spec = BEHAVIOR_SPECS[b?.kind];
    if (!spec) {
      c.issues.push({
        path: `${p}.kind`,
        message: `unknown behaviour ${JSON.stringify(b?.kind)}`,
        fix: `use one of: ${Object.keys(BEHAVIOR_SPECS).join(", ")}`,
      });
      return { kind: "none", at: 0, until: 0, p: {} };
    }
    if (spec.needsAt && b.at === undefined)
      c.issues.push({
        path: `${p}.at`,
        message: `${b.kind} needs "at"`,
        fix: 'add "at": a cue-anchored time such as "S(c01)+0.3"',
      });
    const at = b.at !== undefined ? timeOf(`${p}.at`, b.at, c.issues, c.at) : (show?.[0] ?? c.from);
    const until = b.until !== undefined ? timeOf(`${p}.until`, b.until, c.issues, c.at) : (show?.[1] ?? c.to);
    const params = checkSpec(`${p}.params`, spec.params, b.params as Record<string, unknown>, c.issues, c.at);
    if (b.kind === "fly" && Array.isArray(params.path)) params.path = flyPath(`${p}.params.path`, params.path, c);
    return { kind: b.kind, at, until, p: params };
  });
}

/** a fly path as clean [x, y] number pairs (problems go to c.issues) */
function flyPath(path: string, list: unknown[], c: CompileCtx): [number, number][] {
  const ok = (v: unknown, a: number, b: number) => typeof v === "number" && Number.isFinite(v) && v >= a && v <= b;
  if (!list.length)
    c.issues.push({ path, message: "a fly path needs at least one point", fix: 'e.g. "path": [[120, 60], [200, 40]]' });
  return list.map((pt, i) => {
    if (Array.isArray(pt) && pt.length === 2 && ok(pt[0], -2000, 4000) && ok(pt[1], -400, 400))
      return [pt[0], pt[1]] as [number, number];
    c.issues.push({
      path: `${path}[${i}]`,
      message: `expected an [x, y] point, got ${JSON.stringify(pt)}`,
      fix: "write each point as [x, y] with plain numbers, e.g. [160, 60]",
    });
    return [0, 0] as [number, number];
  });
}

/** sit "on" ids that name no layer (or the layer itself), checked once every id in the scene is known */
function checkSitTargets(layers: CLayer[], ids: Set<string>, base: string, issues: DeclIssue[]) {
  for (const l of layers) {
    l.behaviors.forEach((b, i) => {
      if (b.kind !== "sit" || !b.p.on) return;
      if (b.p.on === l.id || !ids.has(b.p.on))
        issues.push({
          path: `${base}.layer ${l.id}.behaviors[${i}].params.on`,
          message: b.p.on === l.id ? `${l.id} cannot sit on itself` : `no layer "${b.p.on}" to sit on`,
          fix: `use another layer's id (recipe ids are <recipe>_<part>), or "" with x and y for a fixed point`,
        });
    });
    checkSitTargets(l.children, ids, base, issues);
  }
}

function compileLayer(path: string, l: LayerT, c: CompileCtx): CLayer | null {
  if (!l || typeof l !== "object") {
    c.issues.push({
      path,
      message: "a layer must be an object",
      fix: 'e.g. { "id": "hero", "kind": "actor", "props": { "asset": "hero" } }',
    });
    return null;
  }
  if (typeof l.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(l.id))
    c.issues.push({
      path: `${path}.id`,
      message: `bad layer id ${JSON.stringify(l.id)}`,
      fix: "lower-case letters, digits and _, starting with a letter",
    });
  else if (c.ids.has(l.id))
    c.issues.push({ path: `${path}.id`, message: `duplicate layer id "${l.id}"`, fix: "give every layer its own id" });
  c.ids.add(l.id);
  if (!(DECL_KINDS as readonly string[]).includes(l.kind)) {
    c.issues.push({
      path: `${path}.kind`,
      message: `layer kind ${JSON.stringify(l.kind)} cannot be used in a decl scene`,
      fix: l.kind === "code" ? "use a code scene for hand-written drawing" : `use one of: ${DECL_KINDS.join(", ")}`,
    });
    return null;
  }
  let spec = KIND_SPECS[l.kind];
  const props = (l.props ?? {}) as Record<string, unknown>;
  if (l.kind === "widget") {
    const w = WIDGET_SPECS[props.widget as string];
    if (!w) {
      c.issues.push({
        path: `${path}.props.widget`,
        message: `unknown widget ${JSON.stringify(props.widget)}`,
        fix: `use one of: ${Object.keys(WIDGET_SPECS).join(", ")}`,
      });
      return null;
    }
    spec = { ...spec, ...w };
  }
  const show: [number, number] | null = l.show
    ? [timeOf(`${path}.show[0]`, l.show[0], c.issues, c.at), timeOf(`${path}.show[1]`, l.show[1], c.issues, c.at)]
    : null;
  const cp = checkSpec(`${path}.props`, spec, props, c.issues, c.at);
  for (const k of ["asset", "iconAsset"]) if (typeof cp[k] === "string" && cp[k]) c.assets.add(cp[k]);
  if (l.kind === "backdrop" && (cp.style === "night" || cp.style === "rooftop")) {
    if (cp.moon) c.assets.add("moon");
    if (cp.skyline) c.assets.add("skyline");
  }
  if (l.kind === "backdrop" && Array.isArray(cp.chimneys))
    (cp.chimneys as unknown[]).forEach((x, i) => {
      if (typeof x !== "number" || !Number.isFinite(x))
        c.issues.push({
          path: `${path}.props.chimneys[${i}]`,
          message: `expected a world x, got ${JSON.stringify(x)}`,
          fix: "write each chimney as a plain number, e.g. [40, 252]",
        });
    });
  if (l.kind === "fx" && cp.fx === "glow" && Array.isArray(cp.tones)) {
    const tones = cp.tones as string[];
    if (!tones.length || tones.length > 8 || tones.some((k) => !/^[A-Za-z]$/.test(k)))
      c.issues.push({
        path: `${path}.props.tones`,
        message: `glow tones must be 1-8 palette letters, got ${JSON.stringify(tones)}`,
        fix: 'list palette letters from the outer band to the core, e.g. ["A", "n", "c", "H"]',
      });
  }
  if (l.kind === "widget" && cp.widget === "hudSlots")
    cp.items = (cp.items as any[]).map((it, i) => {
      const ip = `${path}.props.items[${i}]`;
      if (!it || typeof it.asset !== "string" || typeof it.frame !== "string") {
        c.issues.push({
          path: ip,
          message: "a slot item needs asset and frame",
          fix: '{ "asset": "items", "frame": "star", "at": "S(c02)+1" }',
        });
        return { asset: "", frame: "", at: c.from };
      }
      c.assets.add(it.asset);
      return {
        asset: it.asset,
        frame: it.frame,
        at: it.at === undefined ? c.from : timeOf(`${ip}.at`, it.at, c.issues, c.at),
      };
    });
  if (l.children?.length && l.kind !== "group")
    c.issues.push({
      path: `${path}.children`,
      message: `only a group has children, not a ${l.kind}`,
      fix: 'wrap them in { "kind": "group", "children": [...] }',
    });
  return {
    id: l.id,
    kind: l.kind,
    z: Number.isInteger(l.z) ? l.z : 0,
    space: l.space === "screen" ? "screen" : "world",
    show,
    props: cp,
    keys: compileKeys(path, l.kind, l.keys, c),
    behaviors: compileBehaviors(path, l, c, show),
    children: (l.children ?? [])
      .map((ch, i) => compileLayer(`${path}.children[${i}]`, ch, c))
      .filter((x): x is CLayer => !!x),
  };
}

export const sceneClock = (pauses: { at: number; dur: number }[]) => (t: number) => {
  let c = t;
  for (const p of pauses) c -= clamp(t - p.at, 0, p.dur);
  return c;
};
/** real time of a motion-clock time (inverse of sceneClock) */
export const realOf = (pauses: { at: number; dur: number }[], c: number) => {
  let shift = 0;
  for (const p of [...pauses].sort((a, b) => a.at - b.at)) if (c + shift > p.at) shift += p.dur;
  return c + shift;
};

function collectSfx(layers: CLayer[], pauses: CompiledScene["pauses"], out: { t: number; type: string }[]) {
  for (const l of layers) {
    const R = (c: number) => (l.space === "world" ? realOf(pauses, c) : c);
    for (const b of l.behaviors) {
      if (b.kind === "jumpArc" && b.p.sfx)
        out.push({ t: R(b.at), type: "jump" }, { t: R(b.at + b.p.dur), type: "land" });
      else if (b.kind === "arc" && b.p.sfx) out.push({ t: R(b.at + b.p.dur), type: b.p.sfx });
      else if ((b.kind === "appear" || b.kind === "disappear") && b.p.sfx) out.push({ t: R(b.at), type: b.p.sfx });
      else if (b.kind === "sit" && b.p.sfx) out.push({ t: R(b.at + b.p.land), type: b.p.sfx });
    }
    const p = l.props;
    if (l.kind === "widget") {
      if ((p.widget === "banner" || p.widget === "toast") && p.sfx) out.push({ t: p.at, type: p.sfx });
      if (p.widget === "qblock" && p.hit !== undefined && p.sfx) out.push({ t: p.hit, type: p.sfx });
      if (p.widget === "counter" && p.sfx) out.push({ t: p.at + p.dur, type: p.sfx });
      if (p.widget === "flagpole" && p.raise !== undefined && p.sfx)
        out.push(
          { t: p.raise, type: "flagpole" },
          { t: p.raise + p.dur, type: "flag" },
          { t: p.raise + p.dur + 0.05, type: "fanfare" },
        );
    }
    collectSfx(l.children, pauses, out);
  }
}

/** rough world x ranges taken by things standing on the ground (for placing default decor) */
function occupied(layers: LayerT[]): [number, number][] {
  const wide: Record<string, number> = { castle: 64, crowd: 48, gamers: 48, skyline: 0 };
  const out: [number, number][] = [];
  for (const l of layers) {
    const p = (l?.props ?? {}) as Record<string, any>;
    if (l?.space === "screen" || typeof p.x !== "number") continue;
    if (l.kind === "actor") out.push([p.x - 10, p.x + 10]);
    else if (l.kind === "sprite") {
      const w = wide[p.asset] ?? 16;
      out.push(p.anchor === "topLeft" || p.anchor === undefined ? [p.x, p.x + w] : [p.x - w / 2, p.x + w / 2]);
    } else if (l.kind === "widget") out.push([p.x - 4, p.x + 24]);
    for (const b of l.behaviors ?? [])
      if (b.kind === "walk" && typeof b.params?.to === "number") out.push([b.params.to - 10, b.params.to + 10]);
  }
  return out;
}

export type CompileOpts = {
  /** add the default night backdrop and ground when a scene has none (default true) */
  autoBackdrop?: boolean;
  /** emit a whoosh at the scene start when it starts after 0 (default true) */
  whoosh?: boolean;
  /** path prefix for error messages, e.g. "scenes[2]" */
  path?: string;
};

/** Expand recipes, validate every layer and resolve every time. Throws DeclError (with .issues, each with a fix). */
export function compileDecl(scene: DeclSceneT, at: At, opts: CompileOpts = {}): CompiledScene {
  const base = opts.path ?? `scene ${scene?.id ?? "?"}`;
  const issues: DeclIssue[] = [];
  const from = timeOf(`${base}.from`, scene.from, issues, at);
  const to = timeOf(`${base}.to`, scene.to, issues, at);
  if (!issues.length && !(to > from))
    issues.push({
      path: `${base}.to`,
      message: `scene ends (${to}) before it starts (${from})`,
      fix: "make to later than from",
    });
  if (issues.length) throw new DeclError(issues);

  // recipes first: their layers sit under the scene's own (same z, earlier in order)
  const out: Required<RecipeOut> = { layers: [], camera: { keys: {}, shakes: [] }, sfx: [], pauses: [] };
  (scene.recipes ?? []).forEach((use, i) => {
    const p = `${base}.recipes[${i}]`;
    const r = RECIPE_MAP[use?.id];
    if (!r) {
      issues.push({
        path: `${p}.id`,
        message: `unknown recipe ${JSON.stringify(use?.id)}`,
        fix: `use one of: ${RECIPES.map((x) => x.id).join(", ")}`,
      });
      return;
    }
    const sameBefore = (scene.recipes ?? []).slice(0, i).filter((u) => u.id === use.id).length;
    const res = expandRecipe(r, (use.params ?? {}) as Record<string, unknown>, {
      at,
      path: p,
      issues,
      scene: { id: scene.id, from, to, cues: scene.cues ?? [] },
      prefix: sameBefore ? `${r.id}${sameBefore + 1}` : r.id,
      layers: out.layers,
    });
    if (!res) return;
    out.layers.push(...res.layers);
    for (const [k, v] of Object.entries(res.camera?.keys ?? {}))
      out.camera.keys![k] = [...(out.camera.keys![k] ?? []), ...v];
    out.camera.shakes!.push(...(res.camera?.shakes ?? []));
    out.sfx.push(...(res.sfx ?? []));
    out.pauses.push(...(res.pauses ?? []));
  });
  const all: LayerT[] = [...out.layers, ...(scene.layers ?? [])];
  if (opts.autoBackdrop !== false && !all.some((l) => l?.kind === "backdrop")) {
    const auto: LayerT[] = [{ id: "auto_sky", kind: "backdrop", z: -100, space: "screen", props: {} }];
    if (!all.some((l) => l?.kind === "tiled")) {
      auto.push({ id: "auto_ground", kind: "tiled", z: -50, space: "world", props: {} });
      // a lamp and a bush, unless something already stands there
      const busy = occupied(all);
      for (const [frame, x] of [
        ["lamp", 24],
        ["bush", 290],
      ] as const)
        if (!busy.some(([a, b]) => x + 12 > a && x - 12 < b))
          auto.push({
            id: `auto_${frame}`,
            kind: "sprite",
            z: -40,
            space: "world",
            props: { asset: "props", frame, x, y: GROUND, anchor: "bottom" },
          });
    }
    all.unshift(...auto);
  }

  const c: CompileCtx = { at, issues, ids: new Set(), from, to, assets: new Set() };
  const own = new Set(scene.layers ?? []);
  const layers = all.map((l) => {
    const li = (scene.layers ?? []).indexOf(l);
    const p = own.has(l)
      ? `${base}.layers[${li}]`
      : `${base}.${l?.id?.startsWith("auto_") ? "" : "recipe layer "}${l?.id}`;
    return compileLayer(p, l, c);
  });

  const camKeys: Record<string, CKey[]> = {};
  const camSrc: Record<string, any[]> = { ...(out.camera.keys ?? {}) };
  for (const [k, v] of Object.entries(scene.camera?.keys ?? {})) camSrc[k] = [...(camSrc[k] ?? []), ...v];
  for (const [k, list] of Object.entries(camSrc)) {
    if (k !== "x" && k !== "y") {
      issues.push({ path: `${base}.camera.keys.${k}`, message: `the camera has no "${k}"`, fix: "key only x and y" });
      continue;
    }
    camKeys[k] = list
      .map((kk: any, i: number) => {
        const t = timeOf(`${base}.camera.keys.${k}[${i}].t`, kk?.t, issues, at);
        const v = Number(kk?.v) || 0;
        return kk?.ease === undefined ? { t, v } : { t, v, ease: kk.ease };
      })
      .sort((a, b) => a.t - b.t);
  }
  const shakes = [...(out.camera.shakes ?? []), ...(scene.camera?.shakes ?? [])].map((s: any, i) => ({
    at: timeOf(`${base}.camera.shakes[${i}].at`, s?.at, issues, at),
    amp: clamp(Number(s?.amp) || 0, 0, 12),
    dur: clamp(Number(s?.dur) || 0.25, 0.02, 3),
  }));
  const pauses = out.pauses.map((p, i) => ({
    at: timeOf(`${base}.pauses[${i}]`, p.at, issues, at),
    dur: clamp(Number(p.dur) || 0, 0, 0.5),
  }));
  const sfx: { t: number; type: string }[] = [];
  out.sfx.forEach((s, i) => {
    if (SFX.has(s.type)) sfx.push({ t: timeOf(`${base}.recipe sfx[${i}]`, s.t, issues, at), type: s.type });
  });
  const ok = layers.filter((x): x is CLayer => !!x);
  checkSitTargets(ok, c.ids, base, issues);
  if (issues.length) throw new DeclError(issues);

  if (opts.whoosh !== false && from > 0.001) sfx.push({ t: from, type: "whoosh" });
  collectSfx(ok, pauses, sfx);
  const usesText = (ls: CLayer[]): boolean =>
    ls.some(
      (l) =>
        l.kind === "text" ||
        (l.kind === "widget" && l.props.widget !== "qblock" && l.props.widget !== "flagpole") ||
        usesText(l.children),
    );
  if (usesText(ok)) c.assets.add("font");
  return {
    id: scene.id,
    from,
    to,
    layers: ok,
    camera: { keys: camKeys, shakes },
    pauses,
    sfx: sfx.filter((s) => s.t >= from - 1e-6 && s.t <= to + 1e-6).sort((a, b) => a.t - b.t),
    assets: [...c.assets].sort(),
  };
}

// ---------------------------------------------------------------- evaluation
type Fx = {
  type: "dust" | "sparkle" | "trail" | "land";
  x: number;
  y: number;
  s: number;
  p: Record<string, any>;
  seed: number;
};
export type LayerState = {
  x: number;
  y: number;
  alpha: number;
  vis: boolean;
  sq: boolean;
  facing: string;
  motion: string;
  motionT0: number;
  /** frame rate of a fly or perch cycle (set by those behaviours) */
  mfps?: number;
  frame?: string;
  text?: string;
  scale?: number;
  colour?: string;
  w?: number;
  h?: number;
  diss: { p: number; dir: string; block: number } | null;
  fx: Fx[];
};
type Env = {
  cs: CompiledScene;
  t: number;
  camX: number;
  camY: number;
  clk: (t: number) => number;
  byId: Map<string, CLayer>;
  memo: Map<string, LayerState>;
  busy: Set<string>;
};

export function keyAt(ks: CKey[], t: number): number | string | boolean {
  if (t <= ks[0].t) return ks[0].v;
  for (let i = 1; i < ks.length; i++) {
    const b = ks[i];
    if (t < b.t) {
      const a = ks[i - 1];
      if (typeof a.v !== "number" || typeof b.v !== "number") return a.v;
      return lerp(a.v, b.v, easeFn(b.ease ?? "linear", (t - a.t) / (b.t - a.t)));
    }
  }
  return ks[ks.length - 1].v;
}

function camAt(cs: CompiledScene, t: number, clk: (t: number) => number) {
  const c = clk(t);
  let x = cs.camera.keys.x ? (keyAt(cs.camera.keys.x, c) as number) : 0;
  let y = cs.camera.keys.y ? (keyAt(cs.camera.keys.y, c) as number) : 0;
  for (const s of cs.camera.shakes) {
    const d = t - s.at;
    if (d < 0 || d >= s.dur) continue;
    const k = s.amp * (1 - d / s.dur);
    x += Math.round(Math.sin(d * 90) * k);
    y += Math.round(Math.cos(d * 70) * k);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** seconds between footstep puffs */
const WALK_DUST = 0.55;
function walkPos(plan: ReturnType<typeof walkPlan>, s: number) {
  if (s <= 0) return 0;
  if (s >= plan.dur) return plan.D;
  if (s < plan.lin) return plan.v * s;
  const u = s - plan.lin;
  return Math.min(plan.D, plan.v * plan.lin + plan.v * (u - (u * u) / (2 * plan.dc)));
}

/** a layer's position, opacity, frame state and effects at time t */
function stateOf(l: CLayer, env: Env, t = env.t, withFx = true): LayerState {
  const memo = withFx && t === env.t;
  const hit = memo ? env.memo.get(l.id) : undefined;
  if (hit) return hit;
  const c = l.space === "world" ? env.clk(t) : t;
  const p = l.props;
  const st: LayerState = {
    x: typeof p.x === "number" ? p.x : 0,
    y: typeof p.y === "number" ? p.y : 0,
    alpha: typeof p.alpha === "number" ? p.alpha : 1,
    vis: !l.show || (t >= l.show[0] && t < l.show[1]),
    sq: false,
    facing: p.facing === "left" ? "left" : "right",
    motion: "idle",
    motionT0: 0,
    diss: null,
    fx: [],
  };
  for (const [k, ks] of Object.entries(l.keys)) {
    const v = keyAt(ks, k === "x" || k === "y" ? c : t);
    if (k === "visible") st.vis = st.vis && v === true;
    else if (k !== "state") (st as any)[k] = v;
  }
  // attach first: it sets the base position
  for (const b of l.behaviors)
    if (b.kind === "attach") {
      const target = env.byId.get(b.p.to);
      if (!target || target === l || env.busy.has(target.id)) continue;
      env.busy.add(l.id);
      const ts = stateOf(target, env, t, false);
      env.busy.delete(l.id);
      let tx = ts.x;
      let ty = ts.y;
      if (target.space === "world" && l.space === "screen") {
        tx -= env.camX;
        ty -= env.camY;
      } else if (target.space === "screen" && l.space === "world") {
        tx += env.camX;
        ty += env.camY;
      }
      st.x = tx + b.p.dx;
      st.y = ty + b.p.dy;
      st.vis = st.vis && ts.vis;
    }
  for (const b of l.behaviors) {
    const s = c - b.at;
    const bp = b.p;
    const inWin = t >= b.at && t < b.until;
    switch (b.kind) {
      case "walk": {
        const plan = walkPlan(st.x, bp as any);
        if (plan.D < 0.5 || s <= 0) break;
        const x0 = st.x;
        st.x = x0 + plan.dir * walkPos(plan, s);
        st.facing = plan.dir > 0 ? "right" : "left";
        if (s < plan.dur) {
          st.motion = "run";
          st.motionT0 = b.at;
        }
        if (withFx && l.kind === "actor" && p.dust)
          for (let k = 1; k * WALK_DUST < Math.min(s, plan.dur - 0.15); k++) {
            const tk = k * WALK_DUST;
            if (s - tk >= 0.3) continue;
            st.fx.push({
              type: "dust",
              x: x0 + plan.dir * walkPos(plan, tk) - plan.dir * 4,
              y: st.y - 1,
              s: s - tk,
              p: { n: 2, spread: 0.5, colour: "q", dir: -plan.dir },
              seed: k * 13 + Math.round(b.at * 7),
            });
          }
        break;
      }
      case "jumpArc": {
        if (s < 0) break;
        if (s < bp.dur) {
          const q = s / bp.dur;
          st.y -= Math.round(4 * bp.height * q * (1 - q));
          st.x += bp.dx * q;
          st.motion = "jump";
        } else {
          st.x += bp.dx;
          const ls = s - bp.dur;
          if (bp.squash && ls < 0.12) st.sq = true;
          if (withFx && p.dust !== false && ls < 0.3)
            st.fx.push({ type: "land", x: st.x, y: st.y - 1, s: ls, p: {}, seed: Math.round(b.at * 10) });
        }
        break;
      }
      case "arc": {
        if (s < 0) break;
        let tx = bp.toX;
        let ty = bp.toY;
        if (bp.screen && l.space === "world") {
          tx += env.camX;
          ty += env.camY;
        }
        const x0 = st.x;
        const y0 = st.y;
        const pos = (qq: number) => [lerp(x0, tx, qq), lerp(y0, ty, qq) - Math.sin(qq * Math.PI) * bp.lift];
        if (withFx && bp.trail && s < bp.dur)
          for (let k = 1; k <= 4; k++) {
            const raw = s / bp.dur - k * 0.06;
            if (raw <= 0) continue;
            const [x, y] = pos(easeFn("outCubic", raw));
            st.fx.push({ type: "trail", x, y, s: k, p: {}, seed: k });
          }
        const [x, y] = s >= bp.dur ? [tx, ty] : pos(easeFn("outCubic", s / bp.dur));
        st.x = x;
        st.y = y;
        if (s >= bp.dur && bp.hide) st.vis = false;
        break;
      }
      case "bob":
        if (inWin) {
          const w = Math.sin(((t - b.at) / bp.period + bp.phase) * Math.PI * 2);
          st.y += bp.hop ? -Math.round(Math.abs(w) * bp.amp) : Math.round(w * bp.amp);
        }
        break;
      case "blink":
        if (inWin && ((t - b.at) * bp.rate) % 1 >= bp.duty) st.vis = false;
        break;
      case "pulse":
        if (inWin) {
          const ph = ((((t - b.at) / bp.period) % 1) + 1) % 1;
          st.alpha *= bp.min + (1 - bp.min) * (0.5 + 0.5 * Math.cos(ph * Math.PI * 2));
        }
        break;
      case "shake": {
        const d = t - b.at;
        if (d >= 0 && d < bp.dur) {
          const k = bp.amp * (1 - d / bp.dur);
          st.x += Math.round(Math.sin(d * 90) * k);
          st.y += Math.round(Math.cos(d * 70) * k);
        }
        break;
      }
      case "squash":
        if (s >= 0 && s < bp.dur) st.sq = true;
        break;
      case "appear": {
        if (s < 0) {
          st.vis = false;
          break;
        }
        if (s >= bp.dur || bp.style === "none") break;
        const q = s / bp.dur;
        if (bp.style === "fade") st.alpha *= q;
        else if (bp.style === "pop") st.y -= Math.round(Math.sin(q * Math.PI) * 4);
        else if (bp.style === "drop") st.y = lerp(st.y - bp.dist, st.y, easeFn("backOut", q));
        else {
          const off = (1 - easeFn("outCubic", q)) * bp.dist;
          if (bp.style === "slideLeft") st.x += off;
          if (bp.style === "slideRight") st.x -= off;
          if (bp.style === "slideUp") st.y += off;
          if (bp.style === "slideDown") st.y -= off;
          st.alpha *= Math.min(1, q * 3);
        }
        break;
      }
      case "disappear":
        if (s >= bp.dur || (s >= 0 && bp.style === "none")) st.vis = false;
        else if (s >= 0) st.alpha *= 1 - s / bp.dur;
        break;
      case "dissolve": {
        const d = t - b.at;
        const q = d / bp.dur;
        if (bp.dir === "in") {
          if (d < 0) st.vis = false;
          else if (q < 1) st.diss = { p: q, dir: "in", block: bp.block };
        } else if (q >= 1) st.vis = false;
        else if (d >= 0) st.diss = { p: q, dir: "out", block: bp.block };
        break;
      }
      case "fly": {
        if (s < 0) break;
        const pts: [number, number][] = [[st.x, st.y], ...(bp.path as [number, number][])];
        if (bp.loop) pts.push([st.x, st.y]);
        const segs = pts.slice(1).map((q, k) => Math.hypot(q[0] - pts[k][0], q[1] - pts[k][1]));
        const total = segs.reduce((a, v) => a + v, 0);
        const run = Math.min(s, b.until - b.at);
        // a loop keeps going round at full speed; a one-way flight slows over its last 0.4 s, like a walk
        let d = 0;
        if (total > 0)
          d = bp.loop
            ? (bp.speed * run) % total
            : walkPos(walkPlan(0, { to: total, speed: bp.speed, decel: 0.4 }), run);
        let k = 0;
        while (k < segs.length - 1 && d > segs[k]) d -= segs[k++];
        const [ax, ay] = pts[k];
        const [bx, by] = pts[k + 1] ?? pts[k];
        const q = segs[k] > 0 ? Math.min(1, d / segs[k]) : 1;
        st.x = lerp(ax, bx, q);
        st.y = lerp(ay, by, q);
        if (Math.abs(bx - ax) > 0.5) st.facing = bx > ax ? "right" : "left";
        if (inWin) {
          st.motion = "fly";
          st.motionT0 = b.at;
          st.mfps = bp.fps;
          st.y += Math.round(Math.sin(((t - b.at) / bp.bobPeriod) * Math.PI * 2) * bp.bob);
        }
        break;
      }
      case "sit": {
        if (s < 0) break;
        let ax = typeof bp.x === "number" ? bp.x : st.x;
        let ay = typeof bp.y === "number" ? bp.y : st.y;
        const target = bp.on ? env.byId.get(bp.on) : undefined;
        if (target && target !== l && !env.busy.has(target.id)) {
          env.busy.add(l.id);
          const ts = stateOf(target, env, t, false);
          env.busy.delete(l.id);
          ax = ts.x;
          ay = ts.y;
          if (target.space === "world" && l.space === "screen") {
            ax -= env.camX;
            ay -= env.camY;
          } else if (target.space === "screen" && l.space === "world") {
            ax += env.camX;
            ay += env.camY;
          }
        }
        ax += bp.dx;
        ay += bp.dy;
        // it faces the way it came in, during the glide and after touchdown
        if (Math.abs(ax - st.x) > 0.5) st.facing = ax > st.x ? "right" : "left";
        if (s < bp.land) {
          // glide in on a small hop, still flapping
          const q = easeFn("inOut", s / bp.land);
          st.x = lerp(st.x, ax, q);
          st.y = lerp(st.y, ay, q) - Math.sin(q * Math.PI) * bp.lift;
          st.motion = "fly";
          st.motionT0 = b.at;
          st.mfps = 8;
        } else {
          st.x = ax;
          st.y = ay;
          if (inWin) {
            st.motion = "perch";
            st.motionT0 = b.at + bp.land;
            st.mfps = bp.fps;
          }
          if (bp.squash && bp.land > 0 && s - bp.land < 0.1) st.sq = true;
        }
        break;
      }
      case "dust":
      case "sparkle": {
        if (!withFx) break;
        const life = b.kind === "dust" ? 0.3 : 0.5;
        for (const d of fxTimes(b.at, bp.every, t, life, b.until))
          st.fx.push({
            type: b.kind as "dust" | "sparkle",
            x: st.x,
            y: st.y,
            s: d,
            p: bp,
            seed: Math.round((t - d) * 10) * 31,
          });
        break;
      }
    }
  }
  if (l.keys.state) {
    const forced = String(keyAt(l.keys.state, t));
    if (forced !== "auto") st.motion = forced;
  }
  if (memo) env.memo.set(l.id, st);
  return st;
}

// ---------------------------------------------------------------- drawing helpers
const mod = (v: number, n: number) => ((v % n) + n) % n;
const fpsN = (t: number, n: number, rate: number) => mod(Math.floor(t * rate), n);
const has = (fr: Frames | null, n: string) => !!fr && Array.isArray(fr[n]);

/** a palette letter the engine knows, else a fallback (keeps other palettes from crashing) */
function col(e: Engine, c: string, fallback = "P"): string {
  if (c.length === 1 && !e.RGB[c]) return e.RGB[fallback] ? fallback : Object.keys(e.RGB)[0];
  return c;
}

function squashRows(rows: Rows, d = 2): Rows {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const mid = Math.floor(w / 2);
  const drop = new Set([Math.floor(h / 2), Math.floor((h * 2) / 3)].slice(0, d));
  return rows.filter((_, j) => !drop.has(j)).map((r) => r.slice(0, mid) + r.slice(mid - d, mid) + r.slice(mid));
}

export function sparkleFx(e: Engine, x: number, y: number, s: number, colour = "P", size = 18) {
  if (s < 0 || s > 0.5) return;
  const r = Math.round(2 + s * size);
  const a = 1 - s / 0.5;
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2;
    e.rect(x + Math.cos(ang) * r, y + Math.sin(ang) * r, 1, 1, colour, a);
    e.rect(x + Math.cos(ang) * (r - 2), y + Math.sin(ang) * (r - 2), 1, 1, colour, a * 0.6);
  }
}
function ringFx(e: Engine, cx: number, cy: number, s: number, colour = "B", size = 18) {
  if (s < 0 || s > 0.4) return;
  const r = Math.round(size + s * 25);
  const a = 1 - s / 0.4;
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * Math.PI * 2;
    e.rect(Math.round(cx + Math.cos(ang) * r), Math.round(cy + Math.sin(ang) * r), 1, 1, colour, a);
    e.rect(Math.round(cx + Math.cos(ang) * (r - 3)), Math.round(cy + Math.sin(ang) * (r - 3)), 1, 1, colour, a * 0.5);
  }
}
function dustFx(
  e: Engine,
  x: number,
  y: number,
  s: number,
  seed: number,
  dir: number,
  n: number,
  spread: number,
  colour: string,
) {
  if (s < 0 || s > 0.3) return;
  const a = 0.85 * (1 - s / 0.3);
  for (let k = 0; k < n; k++) {
    const dx = Math.round(dir * (0.3 + rnd(seed * 7 + k)) * s * 26 * spread);
    const dy = -Math.round((0.2 + rnd(seed * 13 + k)) * s * 14 * spread);
    e.rect(x + dx, y + dy, 1, 1, colour, a);
  }
}
function puffFx(e: Engine, x: number, y: number, s: number) {
  if (s < 0 || s > 0.3) return;
  const p = s / 0.3;
  for (let k = 0; k < 6; k++) {
    const ang = Math.PI * (0.05 + (0.9 * k) / 5);
    const r = 2 + p * 8;
    e.rect(Math.round(x + Math.cos(ang) * r), Math.round(y - Math.sin(ang) * (1 + p * 4)), 1, 1, col(e, "p"), 1 - p);
  }
}
function starfield(e: Engine, t: number, cam: number, n: number) {
  const P = col(e, "P");
  for (let i = 0; i < n; i++) {
    const x = Math.floor(mod(rnd(i) * 420 - cam * 0.05, 420)) - 50;
    const y = Math.floor(rnd(i + 99) * 110);
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (1 + rnd(i + 7) * 3) + i));
    e.rect(x, y, 1, 1, P, tw);
    if (rnd(i + 3) < 0.12) {
      e.rect(x - 1, y, 1, 1, P, tw * 0.4);
      e.rect(x + 1, y, 1, 1, P, tw * 0.4);
      e.rect(x, y - 1, 1, 1, P, tw * 0.4);
      e.rect(x, y + 1, 1, 1, P, tw * 0.4);
    }
  }
}

/** the rooftop backdrop: the night sky, a lower skyline and a slate roof whose ridge is the feet line, with brick
 * chimneys. Every cell is a palette letter (the sky band aside); light comes from the upper left, so top and left
 * edges take the lighter tone and right and bottom edges the darker one. */
function rooftopBackdrop(e: Engine, p: Record<string, any>, t: number, camX: number) {
  if (p.band && e.RGB.l) for (let y = 70; y < GROUND; y++) e.rect(0, y, e.W, 1, "l", ((y - 70) / (GROUND - 70)) * 0.35);
  starfield(e, t, camX, p.stars);
  if (p.moon && e.asset("moon")) e.sprite(e.frame("moon", "moon", [24, 24]), p.moonX - camX * 0.02, p.moonY);
  // the city sits lower than from the street: we look across it from a roof
  if (p.skyline && e.asset("skyline"))
    for (const [layer, par, y] of [
      ["far", 0.15, GROUND - 40],
      ["near", 0.4, GROUND - 28],
    ] as const) {
      const rows = e.frame("skyline", layer, [96, 40]);
      const w = rows[0]?.length || 96;
      const off = mod(camX * par, w);
      for (let x = -off; x < e.W; x += w) e.sprite(rows, x, y);
    }
  const c = (k: string, f = "k") => e.RGB[col(e, k, f)];
  const cam = Math.round(camX);
  const chimneys: number[] = Array.isArray(p.chimneys) ? p.chimneys : [252];
  // the ridge cap: rounded 8 px caps, a lit top, a dark seam between caps and a shadow line under them
  for (let x = 0; x < e.W; x++) {
    const i = mod(x + cam, 8);
    const seam = i === 7;
    e.px(x, GROUND, seam ? c("e") : i < 3 ? c("w") : c("Y"));
    e.px(x, GROUND + 1, seam ? c("k") : i < 2 ? c("Y") : c("F"));
    e.px(x, GROUND + 2, seam ? c("k") : i === 6 ? c("f") : c("F"));
    e.px(x, GROUND + 3, c("k"));
  }
  // slate shingles below the ridge, staggered by half a shingle; the roof slopes toward us, so each row is a
  // little taller and wider than the one above, and the lower rows fall into shadow
  let y0 = GROUND + 4;
  for (let row = 0; y0 < e.H; row++) {
    const th = 4 + row;
    const tw = 8 + 2 * row;
    const deep = row >= 3;
    for (let j = 0; j < th && y0 + j < e.H; j++)
      for (let x = 0; x < e.W; x++) {
        const wx = x + cam + (row % 2) * (tw / 2);
        const i = mod(wx, tw);
        const body = deep ? "f" : rnd(Math.floor(wx / tw) * 7 + row * 131) < 0.15 ? "e" : "F";
        let k = body;
        if (j === th - 1 || i === tw - 1 || (j === th - 2 && (i === 0 || i === tw - 2))) k = "k";
        else if (i === tw - 2 || j === th - 2) k = deep ? "k" : "f";
        else if (j === 0 || i === 0) k = deep ? "F" : "Y";
        e.px(x, y0 + j, c(k));
      }
    y0 += th;
  }
  // brick chimneys standing on the ridge: lit left column, dark right column, mortar lines
  for (const wx of chimneys) {
    const x0 = Math.round(wx) - cam;
    if (x0 > e.W + 2 || x0 < -20) continue;
    const top = GROUND - 22;
    for (let y = top + 3; y < GROUND + 4; y++)
      for (let i = 0; i < 14; i++) {
        const j = y - top - 3;
        const brickRow = Math.floor(j / 3);
        const bi = mod(i + (brickRow % 2) * 3, 6);
        let k = j % 3 === 2 || bi === 5 ? "A" : "R";
        if (i === 0) k = "k";
        else if (i === 13) k = "k";
        else if (i === 12) k = "A";
        else if (i === 1 && k === "R") k = "r";
        e.px(x0 + i, y, c(k));
      }
    // the stone cap, a little wider than the stack, with the dark flue on top
    for (let i = -1; i < 15; i++) {
      e.px(x0 + i, top, i === -1 || i === 14 ? c("k") : i < 6 ? c("W") : c("p"));
      e.px(x0 + i, top + 1, i === -1 || i === 14 ? c("k") : i < 1 ? c("p") : i > 12 ? c("e") : c("q"));
      e.px(x0 + i, top + 2, c("k"));
    }
    for (let i = 3; i < 11; i++) e.px(x0 + i, top - 1, c(i === 3 ? "e" : "k"));
  }
}

const CHECK = ["......T", ".....TT", "T...TT.", "TT.TT..", ".TTT...", "..T...."];

/** frames a creature cycles: fly takes move0.., else run0.., else idle0..; perch takes perch0.., else idle0..;
 * an asset with none of them falls back to `fallback` */
export function motionFrames(fr: Frames | null, motion: string, fallback: string[]): string[] {
  const run = (base: string) => {
    const out: string[] = [];
    for (let i = 0; i < 8 && has(fr, `${base}${i}`); i++) out.push(`${base}${i}`);
    return out;
  };
  for (const base of motion === "fly" ? ["move", "run", "idle"] : ["perch", "idle"]) {
    const list = run(base);
    if (list.length) return list;
  }
  return fallback;
}

/** pick an actor frame from what the asset actually has (library mentors only have idle0, idle1 and give) */
export function actorFrame(
  fr: Frames | null,
  props: Record<string, any>,
  st: Pick<LayerState, "motion" | "motionT0" | "mfps">,
  t: number,
): { name: string; bob: number } {
  const o = (props.frames ?? {}) as Record<string, any>;
  const first = fr ? Object.keys(fr)[0] : "idle0";
  const idles: string[] = Array.isArray(o.idle) ? o.idle : ["idle0", "idle1"].filter((n) => has(fr, n));
  const idle = idles.length ? idles : [first];
  // a walking creature has move0-3 instead of a hero's run0-3
  const own = ["run0", "run1", "run2", "run3"].filter((n) => has(fr, n));
  const runs: string[] = Array.isArray(o.run)
    ? o.run
    : own.length
      ? own
      : ["move0", "move1", "move2", "move3"].filter((n) => has(fr, n));
  const pick = (...names: (string | undefined)[]) => names.find((n) => n && has(fr, n)) ?? idle[0];
  switch (st.motion) {
    case "run": {
      if (runs.length) return { name: runs[fpsN(t - st.motionT0, runs.length, props.runFps)], bob: 0 };
      const k = fpsN(t - st.motionT0, 2, Math.min(props.runFps, 6));
      return { name: idle[k % idle.length], bob: k ? -1 : 0 };
    }
    case "jump":
      return { name: pick(o.jump, "jump", "give"), bob: 0 };
    case "wave":
      return { name: pick(o.wave, "wave", "give"), bob: 0 };
    case "fly":
    case "perch": {
      const own = st.motion === "fly" ? o.fly : o.perch;
      const list: string[] = Array.isArray(own) && own.length ? own : motionFrames(fr, st.motion, idle);
      const rate = st.mfps ?? (st.motion === "fly" ? 8 : 1.5);
      return { name: list[fpsN(t - st.motionT0, list.length, rate)], bob: 0 };
    }
    default:
      return { name: idle[fpsN(t, idle.length, props.idleFps)], bob: 0 };
  }
}

// ---------------------------------------------------------------- draw
type Box = { x: number; y: number; w: number; h: number };
type Rec = (l: CLayer, b: Box, st: LayerState) => void;

function drawLayer(e: Engine, l: CLayer, env: Env, ox: number, oy: number, am: number, rec?: Rec) {
  const st = stateOf(l, env);
  if (!st.vis) return;
  const alpha = clamp(st.alpha * am);
  if (alpha <= 0.001) return;
  const world = l.space === "world" && l.kind !== "backdrop";
  const camX = world ? env.camX : 0;
  const camY = world ? env.camY : 0;
  const sx = Math.round(st.x + ox - camX);
  const sy = Math.round(st.y + oy - camY);
  const t = env.t;
  const p = l.props;
  const saved = st.diss && !rec ? e.buf.slice() : null;
  let box: Box | null = null;
  switch (l.kind) {
    case "backdrop": {
      if (rec) break;
      e.clear(p.sky ?? e.SKY);
      if (p.style === "rooftop") {
        rooftopBackdrop(e, p, t, env.camX);
        break;
      }
      if (p.style !== "night") break;
      if (p.band && e.RGB.l)
        for (let y = 70; y < GROUND; y++) e.rect(0, y, e.W, 1, "l", ((y - 70) / (GROUND - 70)) * 0.35);
      starfield(e, t, env.camX, p.stars);
      if (p.moon && e.asset("moon")) e.sprite(e.frame("moon", "moon", [24, 24]), p.moonX - env.camX * 0.02, p.moonY);
      if (p.skyline && e.asset("skyline"))
        for (const [layer, par, y] of [
          ["far", 0.15, GROUND - 52],
          ["near", 0.4, GROUND - 40],
        ] as const) {
          const rows = e.frame("skyline", layer, [96, 40]);
          const w = rows[0]?.length || 96;
          const off = mod(env.camX * par, w);
          for (let x = -off; x < e.W; x += w) e.sprite(rows, x, y);
        }
      break;
    }
    case "tiled": {
      if (rec || !e.asset(p.asset)) break;
      const top = e.frame(p.asset, p.frame, [p.tile, p.tile]);
      const fill = p.fill ? e.frame(p.asset, p.fill, [p.tile, p.tile]) : null;
      const th = top.length || p.tile;
      const start = Math.max(p.fromX, Math.floor(camX / p.tile) * p.tile);
      for (let wx = start; wx < Math.min(p.toX, camX + e.W + p.tile); wx += p.tile) {
        if ((p.gaps as any[]).some((g) => Array.isArray(g) && wx >= g[0] && wx < g[1])) continue;
        const x = wx - camX + ox;
        e.sprite(top, x, sy, { alpha });
        if (fill) for (let y = sy + th; y < e.H; y += fill.length || p.tile) e.sprite(fill, x, y, { alpha });
      }
      break;
    }
    case "sprite": {
      const fr = e.asset(p.asset);
      const frames: string[] = p.frames;
      const t0 = l.show?.[0] ?? env.cs.from;
      // fly and sit pick the creature's frames (move*, perch*...) from the asset; nothing else reaches this branch
      const moving = st.motion === "fly" || st.motion === "perch";
      const still = p.frame || (fr ? Object.keys(fr)[0] : "");
      const cycle = moving ? motionFrames(fr, st.motion, frames.length ? frames : [still]) : [];
      const name =
        st.frame ??
        (moving
          ? cycle[fpsN(t - st.motionT0, cycle.length, st.mfps ?? (st.motion === "fly" ? 8 : 1.5))]
          : frames.length
            ? frames[fpsN(t - t0, frames.length, p.fps)]
            : still);
      let rows = e.frame(p.asset, name, [16, 16]);
      if (st.sq) rows = squashRows(rows, 1);
      const scale = Math.max(1, Math.round(st.scale ?? p.scale));
      const w = (rows[0]?.length ?? 0) * scale;
      const h = rows.length * scale;
      const x = p.anchor === "topLeft" ? sx : sx - Math.floor(w / 2);
      const y = p.anchor === "bottom" ? sy - h : p.anchor === "center" ? sy - Math.floor(h / 2) : sy;
      box = { x, y, w, h };
      if (!rec)
        e.sprite(rows, x, y, {
          // a flying sprite turns to face where it goes (its art is taken to face right; flip: true for left)
          flip: moving ? (st.facing === "left") !== p.flip : p.flip,
          outline: p.outline ?? undefined,
          alpha,
          colour: p.colour ?? undefined,
          scale,
        });
      break;
    }
    case "actor": {
      const fr = e.asset(p.asset);
      const f = actorFrame(fr, p, st, t);
      let rows = e.frame(p.asset, f.name, [16, 24]);
      if (st.sq) rows = squashRows(rows, 2);
      const scale = Math.max(1, Math.round(p.scale ?? 1));
      const w = (rows[0]?.length ?? 16) * scale;
      const flip = st.facing !== p.artFaces;
      const x = sx - Math.floor(w / 2);
      const y = sy - rows.length * scale + f.bob * scale;
      box = { x, y, w, h: rows.length * scale };
      if (!rec) e.sprite(rows, x, y, { flip, outline: p.outline ?? undefined, alpha, ...(scale > 1 ? { scale } : {}) });
      break;
    }
    case "text": {
      const str = String(st.text ?? p.text);
      let scale = Math.round(st.scale ?? p.scale);
      if (p.fit) while (scale > 1 && e.measure(str, scale) > 304) scale--;
      // fit: true never clips: still too wide at scale 1, it wraps (and, past two lines, ends in "...")
      const fitWrap = p.fit && !p.maxW && e.measure(str, scale) > 304;
      const lines = fitWrap ? fitLines(e, str, 304, 1, 2).lines : p.maxW ? e.wrap(str, p.maxW, scale) : [str];
      const w = Math.max(...lines.map((s) => e.measure(s, scale)));
      const lh = p.maxW || fitWrap ? p.lineH * scale : 8 * scale;
      const x = p.align === "center" ? sx - w / 2 : p.align === "right" ? sx - w : sx;
      const sh = p.shadow ? scale : 0;
      box = { x: Math.round(x), y: sy, w: w + sh, h: (lines.length - 1) * lh + 8 * scale + sh };
      if (!rec)
        lines.forEach((s, i) => {
          e.text(s, sx, sy + i * lh, {
            colour: col(e, st.colour ?? p.colour),
            scale,
            align: p.align,
            shadow: p.shadow,
            alpha,
          });
        });
      break;
    }
    case "panel": {
      const w = Math.round(st.w ?? p.w);
      const h = Math.round(st.h ?? p.h);
      box = { x: sx, y: sy, w: w + 2, h: h + 2 };
      if (!rec)
        e.panel(sx, sy, w, h, { border: col(e, p.border, "G"), fill: col(e, p.fill, "k"), alpha: p.alpha * alpha });
      break;
    }
    case "group":
      for (const ch of zOrder(l.children)) drawLayer(e, ch, env, ox + st.x, oy + st.y, alpha, rec);
      break;
    case "shape": {
      const c = col(e, st.colour ?? p.colour);
      const w = Math.round(st.w ?? p.w);
      const h = Math.round(st.h ?? p.h);
      if (p.shape === "rect") {
        box = { x: sx, y: sy, w, h };
        if (!rec) e.rect(sx, sy, w, h, c, alpha);
      } else if (p.shape === "box") {
        box = { x: sx, y: sy, w, h };
        if (!rec) e.box(sx, sy, w, h, c);
      } else if (p.shape === "disc") {
        box = { x: sx - p.r, y: sy - p.r, w: p.r * 2 + 1, h: p.r * 2 + 1 };
        if (!rec)
          for (let j = -p.r; j <= p.r; j++)
            for (let i = -p.r; i <= p.r; i++)
              if (i * i + j * j <= p.r * p.r + p.r * 0.8) e.rect(sx + i, sy + j, 1, 1, c, alpha);
      } else if (!rec) {
        const x2 = Math.round(p.x2 + ox - camX);
        const y2 = Math.round(p.y2 + oy - camY);
        const n = Math.max(Math.abs(x2 - sx), Math.abs(y2 - sy), 1);
        for (let k = 0; k <= n; k++)
          e.rect(Math.round(lerp(sx, x2, k / n)), Math.round(lerp(sy, y2, k / n)), 1, 1, c, alpha);
      }
      break;
    }
    case "fx":
      if (!rec) drawFx(e, l, env, sx, sy);
      break;
    case "widget":
      box = drawWidget(e, l, env, sx, sy, alpha, !!rec);
      break;
  }
  if (rec) {
    if (box) rec(l, box, st);
    return;
  }
  // behaviour effects, drawn over the layer
  for (const f of st.fx) {
    const fx = Math.round(f.x + ox - camX);
    const fy = Math.round(f.y + oy - camY);
    const isActor = l.kind === "actor";
    const cx = box && !isActor ? fx + Math.floor(box.w / 2) : fx;
    const cy = box ? (isActor ? fy - Math.floor(box.h / 2) : fy + Math.floor(box.h / 2)) : fy;
    if (f.type === "dust") {
      const bx = isActor ? fx : cx;
      const by = isActor ? fy : fy + (box?.h ?? 0);
      const c = col(e, f.p.colour ?? "q");
      if (f.p.dir !== undefined) dustFx(e, bx, by, f.s, f.seed, f.p.dir, f.p.n, f.p.spread, c);
      else {
        dustFx(e, bx + f.p.dx - 4, by, f.s, f.seed, -1, f.p.n, f.p.spread, c);
        dustFx(e, bx + f.p.dx + 4, by, f.s, f.seed + 5, 1, f.p.n, f.p.spread, c);
      }
    } else if (f.type === "land") {
      dustFx(e, fx - 5, fy, f.s, f.seed + 91, -1, 3, 0.7, col(e, "q"));
      dustFx(e, fx + 4, fy, f.s, f.seed + 97, 1, 3, 0.7, col(e, "q"));
    } else if (f.type === "sparkle") sparkleFx(e, cx + f.p.dx, cy + f.p.dy, f.s, col(e, f.p.colour, "B"), f.p.size);
    else if (f.type === "trail") {
      const ox2 = box ? Math.floor(box.w / 2) : 0;
      const oy2 = box ? Math.floor(box.h / 2) : 0;
      e.rect(fx + ox2, fy + oy2, 1, 1, col(e, f.s % 2 ? "B" : "P"), 1 - f.s * 0.22);
    }
  }
  if (saved && st.diss) {
    const { p: q, dir, block } = st.diss;
    for (let y = 0; y < e.H; y++)
      for (let x = 0; x < e.W; x++) {
        const hv = dissolveHash(Math.floor(x / block), Math.floor(y / block));
        if (dir === "in" ? hv < q : hv >= q) continue;
        const i = (y * e.W + x) * 3;
        e.buf[i] = saved[i];
        e.buf[i + 1] = saved[i + 1];
        e.buf[i + 2] = saved[i + 2];
      }
  }
}

/** str cut to maxW px with a trailing "..." (unchanged when it fits) */
export function clipText(e: Engine, str: string, maxW: number, scale = 1) {
  if (e.measure(str, scale) <= maxW) return str;
  const cs = [...str];
  while (cs.length && e.measure(`${cs.join("").trimEnd()}...`, scale) > maxW) cs.pop();
  return `${cs.join("").trimEnd()}...`;
}
/** lines and scale that fit maxW: one line, else wrapped to maxLines, at the largest scale from `scale` down to 1;
 * failing that, wrapped at scale 1 with the last line cut by clipText */
export function fitLines(e: Engine, str: string, maxW: number, scale: number, maxLines: number) {
  for (let k = scale; k >= 1; k--) {
    if (e.measure(str, k) <= maxW) return { lines: [str], scale: k };
    const ls = e.wrap(str, maxW, k);
    if (ls.length <= maxLines && ls.every((l) => e.measure(l, k) <= maxW)) return { lines: ls, scale: k };
  }
  const ls = e.wrap(str, maxW, 1);
  const keep = ls.slice(0, maxLines).map((l) => clipText(e, l, maxW));
  if (ls.length > maxLines) keep[maxLines - 1] = clipText(e, `${keep[maxLines - 1]}...`, maxW);
  return { lines: keep, scale: 1 };
}

export function dissolveHash(x: number, y: number) {
  let s = (Math.imul(x + 11, 374761393) + Math.imul(y + 7, 668265263)) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}

/** ages (seconds since start) of the bursts of a one-shot or repeating effect that are alive at t */
function fxTimes(at: number, every: number, t: number, life: number, until: number) {
  if (every <= 0) return t - at >= 0 && t - at < life ? [t - at] : [];
  if (t < at) return [];
  const k = Math.floor((t - at) / every);
  const out: number[] = [];
  for (let j = Math.max(0, k - Math.ceil(life / every)); j <= k; j++) {
    const s = t - (at + j * every);
    if (s >= 0 && s < life && at + j * every < until) out.push(s);
  }
  return out;
}

/** radial light in whole palette bands, outer tone first: a cell only ever takes a band's exact colour, and only
 * where that is brighter than what is already there, so no blended, off-palette colour appears */
function glowFx(e: Engine, cx: number, cy: number, r: number, tones: RGBT[]) {
  const n = tones.length;
  for (let j = -r; j <= r; j++)
    for (let i = -r; i <= r; i++) {
      const d2 = i * i + j * j;
      if (d2 > r * r + r * 0.8) continue;
      // inner bands are narrower than outer ones, so the light falls off from a small bright core
      const band = Math.min(n - 1, Math.floor((1 - Math.sqrt(d2) / (r + 1)) ** 1.5 * n));
      const c = tones[band];
      const x = cx + i;
      const y = cy + j;
      if (!c || x < 0 || y < 0 || x >= e.W || y >= e.H) continue;
      const k = (y * e.W + x) * 3;
      if (c[0] + c[1] + c[2] > e.buf[k] + e.buf[k + 1] + e.buf[k + 2]) e.px(x, y, c);
    }
}

function drawFx(e: Engine, l: CLayer, env: Env, x: number, y: number) {
  const p = l.props;
  const t = env.t;
  const at = p.at ?? env.cs.from;
  const until = l.show?.[1] ?? env.cs.to;
  const c = col(e, p.colour, "B");
  switch (p.fx) {
    case "sparkle":
      for (const s of fxTimes(at, p.every, t, 0.5, until)) sparkleFx(e, x, y, s, c, p.size);
      break;
    case "ring":
      for (const s of fxTimes(at, p.every, t, 0.4, until)) ringFx(e, x, y, s, c, p.size);
      break;
    case "dust":
      for (const s of fxTimes(at, p.every, t, 0.3, until)) puffFx(e, x, y, s);
      break;
    case "flash":
      for (const s of fxTimes(at, p.every, t, p.dur, until))
        e.rect(0, 0, e.W, e.H - 26, col(e, p.colour, "P"), 0.3 * (1 - s / p.dur));
      break;
    case "fireworks": {
      const s0 = t - at;
      if (s0 < 0) break;
      const cols = ["T", "B", "O"].map((k) => col(e, k));
      for (let k = 0; k < p.n; k++) {
        const tk = rnd(k + 40) * 1.5;
        const fx = Math.round(x - p.w / 2 + rnd(k + 41) * p.w);
        const fy = Math.round(y - p.h / 2 + rnd(k + 42) * p.h);
        sparkleFx(e, fx, fy, s0 - tk, cols[k % 3], p.size);
        sparkleFx(e, fx, fy, s0 - tk - 0.08, col(e, "P"), p.size);
      }
      break;
    }
    case "twinkle": {
      const P = e.RGB[col(e, "P")];
      const B = e.RGB[c] ?? P;
      for (let k = 0; k < p.n; k++) {
        const sx = Math.round(x - p.w / 2 + rnd(k * 5 + 1) * p.w);
        const sy = Math.round(y - p.h / 2 + rnd(k * 5 + 2) * p.h);
        const cyc = mod(t - env.cs.from + rnd(k * 5 + 3) * 4, 4);
        if (cyc < 0.35) {
          e.px(sx, sy, P);
          e.px(sx - 1, sy, P, 0.6);
          e.px(sx + 1, sy, P, 0.6);
          e.px(sx, sy - 1, P, 0.6);
          e.px(sx, sy + 1, P, 0.6);
        } else if (cyc < 0.7) e.px(sx, sy, B);
        else e.px(sx, sy, P, 0.4);
      }
      break;
    }
    case "glow": {
      if (t < at) break;
      const tones = ((p.tones as string[] | undefined)?.length ? p.tones : ["A", "n", "c", "H"]) as string[];
      const rgb = tones.map((k) => e.RGB[col(e, k)]);
      const breath = p.pulse ? Math.round(p.pulse * Math.sin(((t - at) / (p.period ?? 2)) * Math.PI * 2)) : 0;
      glowFx(e, x, y, Math.max(1, Math.round(p.size) + breath), rgb);
      break;
    }
    case "shootingStar": {
      const every = p.every > 0 ? p.every : 7;
      const ls = t - at;
      if (ls < 0) break;
      const cyc = mod(ls, every);
      const lane = Math.floor(ls / every) % 2;
      if (cyc >= 1.6) break;
      const q = cyc / 1.6;
      const [x0, x1, y0, y1] = lane ? [300, 90, 3, 10] : [250, 30, 5, 13];
      const hx = Math.round(lerp(x0, x1, q));
      const hy = Math.round(lerp(y0, y1, q));
      const edge = Math.min(1, q / 0.15, (1 - q) / 0.15);
      const slope = (y1 - y0) / (x0 - x1);
      e.px(hx, hy, e.RGB[col(e, "P")], edge);
      for (let k = 1; k <= 9; k++) e.px(hx + k, hy - Math.round(k * slope), e.RGB[c], edge * (1 - k / 10));
      break;
    }
  }
}

function drawWidget(e: Engine, l: CLayer, env: Env, sx: number, sy: number, alpha: number, dry: boolean): Box | null {
  const p = l.props;
  const t = env.t;
  switch (p.widget) {
    case "banner": {
      const s = t - p.at;
      if (s < 0 || s > p.dur) return null;
      const a = s < 0.12 ? s / 0.12 : s > p.dur - 0.25 ? (p.dur - s) / 0.25 : 1;
      // never clipped: a line too wide wraps to two, then drops a scale, then ends in "..."
      const fit = fitLines(e, p.text, e.W - 24, p.scale, 2);
      const w = Math.max(...fit.lines.map((l) => e.measure(l, fit.scale))) + 16;
      const y = p.y + Math.round((1 - easeFn("outCubic", s / 0.2)) * -40);
      const h = fit.lines.length * 8 * fit.scale + (fit.lines.length - 1) * 2 * fit.scale + 6;
      const x = Math.round(e.W / 2 - w / 2);
      if (!dry) {
        const c = col(e, p.colour, "O");
        e.panel(x, y, w, h, { border: c });
        fit.lines.forEach((l, i) => {
          e.text(l, e.W / 2, y + 4 + i * 10 * fit.scale, {
            align: "center",
            scale: fit.scale,
            colour: fpsN(s, 2, 8) ? c : col(e, "P"),
            alpha: a * alpha,
          });
        });
      }
      return { x, y, w: w + 2, h: h + 2 };
    }
    case "toast": {
      const s = t - p.at;
      if (s < 0 || s > p.dur) return null;
      // widen to fit its words (up to the frame), and cut what still does not fit with "..."
      const room = e.W - 12;
      const need = Math.max(e.measure(p.title), p.sub ? e.measure(p.sub) : 0) + 26;
      const w = need > p.w ? Math.min(room, need) : p.w;
      const title = clipText(e, p.title, w - 26);
      const sub = p.sub ? clipText(e, p.sub, w - 26) : p.sub;
      const out = s > p.dur - 0.3 ? easeFn("outCubic", (s - (p.dur - 0.3)) / 0.3) * (w + 10) : 0;
      const x = Math.round(e.W - 6 - w + (1 - easeFn("outCubic", s / 0.25)) * (w + 10) + out);
      if (!dry) {
        const c = col(e, p.colour, "B");
        e.panel(x, p.y, w, 22, { border: c });
        if (e.asset(p.iconAsset)) e.sprite(e.frame(p.iconAsset, p.icon, [12, 12]), x + 5, p.y + 5, { outline: "k" });
        e.text(title, x + 22, p.y + (sub ? 3 : 7), { colour: c });
        if (sub) e.text(sub, x + 22, p.y + 12, { colour: col(e, "P") });
      }
      return x < e.W ? { x, y: p.y, w: Math.min(w + 2, e.W - x), h: 24 } : null;
    }
    case "nameTag": {
      const w = e.measure(p.label) + 6;
      const x = Math.round(sx - w / 2);
      if (!dry) {
        const c = col(e, p.colour, "T");
        e.panel(x, sy, w, 11, { border: c });
        e.text(p.label, sx, sy + 2, { align: "center", colour: col(e, "P"), shadow: false, alpha });
        e.rect(sx - 1, sy + 11, 3, 1, c);
        e.rect(sx, sy + 12, 1, 1, c);
      }
      return { x, y: sy, w: w + 2, h: 13 };
    }
    case "label": {
      // a painted sign: planks (or a stone plaque) with a lit top-left edge, a dark lower-right edge and nails,
      // standing on two posts, hanging from a bar, or on its own
      const scale = p.scale;
      const text = clipText(e, p.text, 200, scale);
      const w = e.measure(text, scale) + 14;
      const h = 8 * scale + 8;
      const x = Math.round(sx - w / 2);
      const y = sy;
      if (!dry) {
        const wood = p.style !== "slate";
        const [lit, body, dark, grain, nail] = (wood ? ["c", "n", "A", "a", "q"] : ["Y", "F", "f", "e", "w"]).map((k) =>
          col(e, k, "k"),
        );
        const ground = l.space === "world" ? GROUND - env.camY : GROUND;
        if (p.mount === "posts" && y + h < ground)
          for (const px of [x + 3, x + w - 6]) {
            e.rect(px, y + h, 3, ground - y - h, col(e, "k"), alpha);
            e.rect(px + 1, y + h, 1, ground - y - h, col(e, wood ? "n" : "F", "k"), alpha);
          }
        if (p.mount === "hang") {
          e.rect(x - 2, y - 8, w + 4, 3, col(e, "k"), alpha);
          e.rect(x - 1, y - 7, w + 2, 1, col(e, wood ? "n" : "F", "k"), alpha);
          for (const cx of [x + 4, x + w - 5]) e.rect(cx, y - 5, 1, 5, col(e, "q", "k"), alpha);
        }
        e.rect(x + 2, y + 2, w, h, col(e, "k"), alpha * 0.5);
        e.rect(x, y, w, h, col(e, "k"), alpha);
        e.rect(x + 1, y + 1, w - 2, h - 2, body, alpha);
        if (wood)
          for (let k = 0; k < w - 8; k += 5) e.rect(x + 3 + k + (k % 2), y + Math.floor(h / 2), 3, 1, grain, alpha);
        e.rect(x + 1, y + 1, w - 2, 1, lit, alpha);
        e.rect(x + 1, y + 1, 1, h - 2, lit, alpha);
        e.rect(x + 1, y + h - 2, w - 2, 1, dark, alpha);
        e.rect(x + w - 2, y + 1, 1, h - 2, dark, alpha);
        for (const [nx, ny] of [
          [x + 3, y + 3],
          [x + w - 4, y + 3],
          [x + 3, y + h - 4],
          [x + w - 4, y + h - 4],
        ])
          e.rect(nx, ny, 1, 1, nail, alpha);
        e.text(text, x + Math.floor(w / 2), y + 4, { align: "center", scale, colour: col(e, p.colour), alpha });
      }
      return { x, y, w: w + 2, h: h + 2 };
    }
    case "hudSlots": {
      const W = hudWidth(p.slots);
      if (!dry) {
        e.panel(sx, sy, W, 18, { border: col(e, p.colour, "G") });
        for (let i = 0; i < p.slots; i++) {
          const [x, y] = hudSlot(sx, sy, i);
          e.rect(x, y, 13, 12, col(e, "l", "k"), 0.6);
        }
        (p.items as { asset: string; frame: string; at: number }[]).forEach((it, i) => {
          if (i >= p.slots || t < it.at || !it.asset) return;
          const [x, y] = hudSlot(sx, sy, i);
          if (e.asset(it.asset)) e.sprite(e.frame(it.asset, it.frame, [12, 12]), x, y, { alpha });
          const s = t - it.at;
          if (p.check && s < 0.6) {
            if (s < 0.3 || fpsN(s, 2, 8)) e.box(x - 1, y - 1, 15, 14, col(e, "T"));
            e.sprite(CHECK, x + 3, y + 17);
          }
        });
      }
      return { x: sx, y: sy, w: W + 2, h: 20 };
    }
    case "qblock": {
      const hs = p.hit === undefined ? -1 : t - p.hit;
      const bump = hs >= 0 && hs < 0.2 ? -Math.round(p.bump * Math.sin((Math.PI * hs) / 0.2)) : 0;
      const f = p.hit !== undefined && hs >= 0 ? "used" : fpsN(t, 2, 3) ? "glow" : "normal";
      if (!dry) e.sprite(e.frame(p.asset, f, [16, 16]), sx, sy + bump, { alpha });
      return { x: sx, y: sy + bump, w: 16, h: 16 };
    }
    case "counter": {
      const q = easeFn("outCubic", (t - p.at) / p.dur);
      const v = Math.round(lerp(p.from, p.to, t < p.at ? 0 : q));
      const str = `${p.label}${String(v).padStart(p.pad, "0")}`;
      const w = e.measure(str, p.scale);
      if (!dry) e.text(str, sx, sy, { align: p.align, scale: p.scale, colour: col(e, p.colour, "B"), alpha });
      const x = p.align === "center" ? sx - w / 2 : p.align === "right" ? sx - w : sx;
      return { x: Math.round(x), y: sy, w: w + p.scale, h: 9 * p.scale };
    }
    case "flagpole": {
      const top = sy - p.height;
      const rp = p.raise === undefined ? 1 : easeFn("outCubic", (t - p.raise) / p.dur);
      const fy = Math.round(lerp(sy - 16, top + 6, rp));
      if (!dry) {
        e.rect(sx, top, 2, p.height, col(e, "p"));
        e.rect(sx + 2, top, 1, p.height, col(e, "q"));
        e.rect(sx - 1, top - 4, 4, 4, col(e, "B"));
        e.rect(sx - 2, sy - 2, 7, 2, col(e, "e", "q"));
        const frames: string[] = p.frames;
        if (e.asset(p.asset) && frames.length) {
          const name = frames[fpsN(t, frames.length, rp < 1 ? 8 : 4)];
          e.sprite(e.frame(p.asset, name, [24, 32]), sx - 1, fy - 5, { alpha });
        }
      }
      return { x: sx - 2, y: top - 4, w: 24, h: p.height + 4 };
    }
  }
  return null;
}

function makeEnv(cs: CompiledScene, t: number): Env {
  const clk = sceneClock(cs.pauses);
  const cam = camAt(cs, t, clk);
  const byId = new Map<string, CLayer>();
  const walk = (ls: CLayer[]) => {
    for (const l of ls) {
      byId.set(l.id, l);
      walk(l.children);
    }
  };
  walk(cs.layers);
  return { cs, t, camX: cam.x, camY: cam.y, clk, byId, memo: new Map(), busy: new Set() };
}

const zOrder = (ls: CLayer[]) =>
  ls
    .map((l, i) => [l, i] as const)
    .sort((a, b) => a[0].z - b[0].z || a[1] - b[1])
    .map(([l]) => l);

/** draw scene time t (absolute seconds) */
export function drawDecl(e: Engine, cs: CompiledScene, t: number) {
  const env = makeEnv(cs, t);
  e.clear();
  for (const l of zOrder(cs.layers)) drawLayer(e, l, env, 0, 0, 1);
}

export type Inspected = {
  id: string;
  kind: string;
  widget?: string;
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
/** the visible layers at t with their screen boxes (texts, sprites, actors, panels, widgets), for lints and the UI */
export function inspectDecl(e: Engine, cs: CompiledScene, t: number): Inspected[] {
  const env = makeEnv(cs, t);
  const out: Inspected[] = [];
  for (const l of zOrder(cs.layers))
    drawLayer(e, l, env, 0, 0, 1, (ll, b, st) => {
      const p = ll.props;
      const text =
        ll.kind === "text"
          ? String(st.text ?? p.text)
          : ll.kind === "widget"
            ? (p.text ?? p.title ?? p.label)
            : undefined;
      out.push({
        id: ll.id,
        kind: ll.kind,
        widget: p.widget,
        text: text === undefined ? undefined : String(text),
        ...b,
      });
    });
  return out;
}
