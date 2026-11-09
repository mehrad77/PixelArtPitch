// The render sandbox: a child process that draws frames. Started by renderer.ts with
//   --permission (fs read limited to the PAP packages, no child processes, no workers, no addons)
//   --disallow-code-generation-from-strings (no eval / new Function in any realm, so host functions can't be used to escape)
//   --experimental-vm-modules, an empty env and an IPC channel.
// Code bundles run as ES modules inside a vm context with no Node globals (no process, require, fetch). They can only
// import "pap:engine" and "pap:timeline" (the first video's "./engine.mjs" and "./timeline.mjs" are aliases).
// Frames go out on stdout as raw 320x180 RGB, one after another.
import vm from "node:vm";
import { type ComposeCtx, captions, dissolving, sceneAt, transitions } from "@pap/engine/compose";
import { createEngine, ENGINE_EXPORTS, type Engine, type Frames } from "@pap/engine/core";
import { type CompiledScene, drawDecl } from "@pap/engine/decl";

export type InitMsg = {
  cmd: "init";
  colours: Record<string, string>;
  sky: string;
  assets: [string, Frames][];
  /** asset id -> which way its art looks (only the assets that say) */
  facing?: Record<string, "left" | "right">;
  fontAssets?: string[];
  timeline: Record<string, unknown> & { TIMES: number[][] };
  compose: ComposeCtx & { captionsByHost: boolean };
  scenes: ({ id: string; from: number; to: number } & (
    | { kind: "code"; bundle: string }
    | { kind: "decl"; compiled: CompiledScene }
  ))[];
  bundles: { id: string; source: string; fullFrame: boolean; sfx: boolean; initArg: unknown }[];
  frameTimeoutMs?: number;
  /** a trial render (the Scene Coder's checks): bundles get text, panel and frame wrapped to record what they draw */
  probe?: boolean;
};
/** what a bundle drew in one probed frame: text and panel boxes, and frames asked of assets the project lacks */
export type ProbeBox =
  | { kind: "text"; text: string; x: number; y: number; w: number; h: number }
  | { kind: "panel"; x: number; y: number; w: number; h: number }
  | { kind: "missing-asset"; name: string }
  | { kind: "missing-frame"; name: string; frame: string };
type Msg =
  | InitMsg
  | { cmd: "frames"; from: number; to: number; fps: number; hold: number; id: number }
  | { cmd: "frame"; t: number; id: number }
  | { cmd: "sfx"; id: number }
  | { cmd: "probe"; t: number; id: number };

type Bundle = { ctx: vm.Context; ns: any; draw: vm.Script; fullFrame: boolean; sfx: boolean };

let engine: Engine;
let init: InitMsg;
const bundles = new Map<string, Bundle>();
const send = (m: unknown) => process.send!(m);

let probeLog: ProbeBox[] = [];
/** the engine a probed bundle sees: the same functions, with text, panel and frame recording their boxes first */
function probed(e: Engine): Engine {
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    ...e,
    text(str: string, x: number, y: number, opts: any = {}) {
      const scale = num(opts?.scale, 1);
      const w = e.measure(String(str), scale);
      const ax = Math.round(opts?.align === "center" ? x - w / 2 : opts?.align === "right" ? x - w : x);
      probeLog.push({ kind: "text", text: String(str).slice(0, 80), x: ax, y: Math.round(num(y)), w, h: 8 * scale });
      return e.text(str, x, y, opts);
    },
    panel(x: number, y: number, w: number, h: number, opts?: any) {
      probeLog.push({ kind: "panel", x: Math.round(num(x)), y: Math.round(num(y)), w: num(w), h: num(h) });
      return e.panel(x, y, w, h, opts);
    },
    frame(name: string, f: string, fallback?: [number, number]) {
      const a = e.asset(name);
      if (!a) probeLog.push({ kind: "missing-asset", name: String(name) });
      else if (!(f in a)) probeLog.push({ kind: "missing-frame", name: String(name), frame: String(f) });
      return e.frame(name, f, fallback);
    },
  };
}

async function loadBundle(b: InitMsg["bundles"][number]): Promise<Bundle> {
  const ctx = vm.createContext(Object.create(null), {
    name: `pap:bundle/${b.id}`,
    codeGeneration: { strings: false, wasm: false },
  });
  const api = init.probe ? probed(engine) : engine;
  const engineMod = new vm.SyntheticModule(
    [...ENGINE_EXPORTS],
    function (this: vm.SyntheticModule) {
      for (const k of ENGINE_EXPORTS) this.setExport(k, (api as any)[k]);
    },
    { context: ctx, identifier: "pap:engine" },
  );
  const tl = init.timeline;
  // S(4) or S("c05"): a cue by its index or its id
  const ids = (tl.CUE_IDS ?? []) as string[];
  const cue = (c: number | string) => {
    const k = typeof c === "number" ? c : ids.indexOf(c);
    if (!tl.TIMES[k]) throw new Error(`no cue ${JSON.stringify(c)}: use a cue id (${ids.join(", ")}) or its index`);
    return tl.TIMES[k];
  };
  const tlExports = { ...tl, S: (c: number | string) => cue(c)[0], E: (c: number | string) => cue(c)[1] };
  const timelineMod = new vm.SyntheticModule(
    Object.keys(tlExports),
    function (this: vm.SyntheticModule) {
      for (const [k, v] of Object.entries(tlExports)) this.setExport(k, v);
    },
    { context: ctx, identifier: "pap:timeline" },
  );
  const mod = new vm.SourceTextModule(b.source, { context: ctx, identifier: `pap:bundle/${b.id}` });
  await mod.link((spec: string) => {
    if (spec === "pap:engine" || spec === "./engine.mjs") return engineMod;
    if (spec === "pap:timeline" || spec === "./timeline.mjs") return timelineMod;
    throw new Error(`code bundle ${b.id} may only import "pap:engine" and "pap:timeline", not "${spec}"`);
  });
  await mod.evaluate({ timeout: 5000 });
  const ns: any = mod.namespace;
  if (typeof ns.draw !== "function") throw new Error(`code bundle ${b.id} must export draw(t)`);
  if (b.initArg !== undefined && typeof ns.init === "function") ns.init(b.initArg);
  (ctx as any).__pap_draw = ns.draw;
  return { ctx, ns, draw: new vm.Script("__pap_draw(__pap_t)"), fullFrame: b.fullFrame, sfx: b.sfx };
}

function drawScene(sc: (typeof init.scenes)[number], t: number) {
  if (sc.kind === "code") {
    const b = bundles.get(sc.bundle)!;
    (b.ctx as any).__pap_t = t;
    b.draw.runInContext(b.ctx, { timeout: init.frameTimeoutMs ?? 250 });
    return b.fullFrame;
  }
  drawDecl(engine, sc.compiled, t);
  return false;
}

/** the outgoing scene's last frame, which the dissolve into the next scene reveals it over */
const lastFrames = new Map<string, Uint8Array>();
function lastFrame(sc: (typeof init.scenes)[number]) {
  let f = lastFrames.get(sc.id);
  if (!f) {
    drawScene(sc, sc.to - 1e-4);
    f = Uint8Array.from(engine.buf);
    lastFrames.set(sc.id, f);
  }
  return f;
}

function drawAt(t: number) {
  const sc = sceneAt(init.scenes, t);
  const full = sc.kind === "code" && bundles.get(sc.bundle)!.fullFrame;
  const k = init.scenes.indexOf(sc);
  const prev = !full && k > 0 && dissolving(init.compose, t) ? lastFrame(init.scenes[k - 1]) : undefined;
  if (drawScene(sc, t)) return;
  transitions(engine, init.compose, t, prev);
  if (init.compose.captionsByHost) captions(engine, init.compose, t);
}

const out = (b: Uint8Array) =>
  process.stdout.write(b) ? Promise.resolve() : new Promise<void>((r) => process.stdout.once("drain", () => r()));

process.on("message", async (m: Msg) => {
  try {
    if (m.cmd === "init") {
      init = m;
      lastFrames.clear();
      engine = createEngine({
        colours: m.colours,
        sky: m.sky,
        assets: new Map(m.assets),
        facing: m.facing,
        fontAssets: m.fontAssets,
        buffer: Buffer.alloc(320 * 180 * 3),
      });
      for (const b of m.bundles) bundles.set(b.id, await loadBundle(b));
      send({ ok: true, cmd: "init" });
    } else if (m.cmd === "frames") {
      for (let i = m.from; i < m.to; i++) {
        drawAt(Math.max(0, i / m.fps - m.hold));
        await out(Buffer.from(engine.buf));
      }
      send({ ok: true, cmd: "frames", id: m.id });
    } else if (m.cmd === "frame") {
      drawAt(m.t);
      await out(Buffer.from(engine.buf));
      send({ ok: true, cmd: "frame", id: m.id });
    } else if (m.cmd === "probe") {
      // what this scene's bundle draws at t, and how long its draw takes (no frame is sent)
      const sc = sceneAt(init.scenes, m.t);
      probeLog = [];
      const t0 = performance.now();
      drawScene(sc, m.t);
      const ms = performance.now() - t0;
      send({ ok: true, cmd: "probe", id: m.id, scene: sc.id, boxes: probeLog, ms });
    } else if (m.cmd === "sfx") {
      const events: { t: number; type: string }[] = [];
      for (const b of bundles.values())
        if (b.sfx) for (const e of b.ns.sfxEvents()) events.push({ t: e.t, type: e.type });
      for (const s of init.scenes) if (s.kind === "decl") events.push(...s.compiled.sfx);
      send({ ok: true, cmd: "sfx", id: m.id, events });
    }
  } catch (e: any) {
    send({ ok: false, cmd: m.cmd, id: (m as any).id, error: String(e?.message ?? e) });
  }
});
send({ ready: true });
