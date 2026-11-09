// Host side of the render sandbox: starts sandbox-child.ts with Node's permission model and streams frames back.
import { type ChildProcess, fork } from "node:child_process";
import { compileDecl } from "@pap/engine/decl";
import { PAP_ROOT } from "./library.ts";
import { type LoadedProject, timelineModule } from "./project.ts";
import type { InitMsg, ProbeBox } from "./sandbox-child.ts";

export type { ProbeBox };

export const W = 320;
export const H = 180;
export const FRAME_BYTES = W * H * 3;
export const FPS = 30;

/** frame count and time of frame i, exactly as the first video's render.mjs did it */
export const frameCount = (duration: number, hold: number, fps = FPS) => Math.round((duration + hold) * fps);
export const timeOfFrame = (i: number, hold: number, fps = FPS) => Math.max(0, i / fps - hold);

export function initMessage(p: LoadedProject): InitMsg {
  const { doc, timeline } = p;
  const usesFont = p.assets.some(([n]) => n === "font");
  return {
    cmd: "init",
    colours: p.palette.colours,
    sky: p.palette.sky,
    assets: p.assets,
    facing: p.facing ?? {},
    fontAssets: usesFont ? ["font"] : undefined,
    timeline: timelineModule(p) as InitMsg["timeline"],
    compose: {
      cues: timeline.cues,
      scenes: timeline.scenes,
      duration: timeline.duration,
      captions: doc.composition.captions,
      dissolveIn: doc.composition.dissolveIn,
      fadeOut: doc.composition.fadeOut,
      captionsByHost: doc.composition.captions.by === "host",
    },
    scenes: doc.scenes.map((s, i) => {
      const win = timeline.scenes[i];
      return s.kind === "code"
        ? { id: s.id, from: win.from, to: win.to, kind: "code" as const, bundle: s.bundle }
        : { id: s.id, from: win.from, to: win.to, kind: "decl" as const, compiled: compileDecl(s, timeline.at) };
    }),
    ...(p.probe ? { probe: true } : {}),
    bundles: p.bundles.map((b) => ({
      id: b.id,
      source: b.source,
      fullFrame: b.fullFrame,
      sfx: b.sfx,
      initArg: b.initArg,
    })),
  };
}

export class Renderer {
  private child!: ChildProcess;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private seq = 0;
  private buf: Buffer = Buffer.alloc(0);
  private onFrame: ((f: Buffer) => void | Promise<void>) | null = null;
  private ready!: Promise<void>;
  /** the child died (a crash, a kill, an edit that broke its import graph): the next call starts a new one */
  private dead: Error | null = null;
  private closed = false;
  private respawning: Promise<void> | null = null;
  /** frames come back on one pipe: one frame request at a time, in order */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
  readonly project: LoadedProject;

  constructor(project: LoadedProject) {
    this.project = project;
    this.spawn();
  }

  /** start a sandbox child; its death rejects every pending call and never throws out of this process */
  private spawn() {
    this.dead = null;
    this.buf = Buffer.alloc(0);
    const child = fork(new URL("./sandbox-child.ts", import.meta.url).pathname, [], {
      execArgv: [
        "--permission",
        `--allow-fs-read=${PAP_ROOT}/*`,
        "--experimental-vm-modules",
        "--disallow-code-generation-from-strings",
        "--max-old-space-size=512",
        "--no-warnings",
      ],
      env: {},
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    this.child = child;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (child !== this.child) return;
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      while (this.buf.length >= FRAME_BYTES) {
        const f = this.buf.subarray(0, FRAME_BYTES);
        this.buf = this.buf.subarray(FRAME_BYTES);
        this.onFrame?.(Buffer.from(f));
      }
    });
    let readyRes: () => void;
    let readyRej: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      readyRes = res;
      readyRej = rej;
    });
    this.ready.catch(() => {});
    child.on("message", (m: any) => {
      if (child !== this.child) return;
      if (m.ready) return readyRes();
      if (m.cmd === "init") {
        const p = this.pending.get(-1);
        this.pending.delete(-1);
        return m.ok ? p?.res(m) : p?.rej(new Error(m.error));
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.res(m) : p.rej(new Error(m.error));
    });
    const die = (err: Error) => {
      if (child !== this.child || this.dead) return;
      this.dead = err;
      readyRej(err);
      for (const p of this.pending.values()) p.rej(err);
      this.pending.clear();
    };
    child.on("error", (e) => die(new Error(`render sandbox failed: ${e.message}`)));
    child.on("exit", (code, signal) => die(new Error(`render sandbox exited (${signal ?? code})`)));
  }

  /** a dead child is replaced (and given the project again) before the next call; a closed renderer stays closed */
  private async alive() {
    if (!this.dead) return;
    if (this.closed) throw new Error("the renderer is closed");
    this.respawning ??= (async () => {
      this.spawn();
      await this.ready;
      await this.send(initMessage(this.project), -1);
    })().finally(() => {
      this.respawning = null;
    });
    await this.respawning;
  }

  private send(msg: any, id: number): Promise<any> {
    return new Promise((res, rej) => {
      if (this.dead) return rej(this.dead);
      this.pending.set(id, { res, rej });
      const fail = (e: Error) => {
        this.pending.delete(id);
        rej(new Error(`render sandbox channel closed: ${e.message}`));
      };
      try {
        this.child.send(id === -1 ? msg : { ...msg, id }, (e) => e && fail(e));
      } catch (e: any) {
        fail(e);
      }
    });
  }

  private async call(msg: any, id = ++this.seq): Promise<any> {
    await this.alive();
    return this.send(msg, id);
  }

  async start() {
    await this.ready;
    await this.send(initMessage(this.project), -1);
    return this;
  }

  /** frames [from, to) in order; onFrame gets each raw RGB frame */
  frames(from: number, to: number, onFrame: (f: Buffer, i: number) => void | Promise<void>) {
    return this.serial(() => this.framesNow(from, to, onFrame));
  }
  private async framesNow(from: number, to: number, onFrame: (f: Buffer, i: number) => void | Promise<void>) {
    let i = from;
    const got: Buffer[] = [];
    this.onFrame = (f) => {
      got.push(f);
    };
    let failed: unknown = null;
    const done = this.call({ cmd: "frames", from, to, fps: FPS, hold: this.project.timeline.hold });
    done.catch((e) => {
      failed = e;
    });
    // deliver in order as they arrive (a child that dies stops the wait)
    while (i < to) {
      if (failed) {
        this.onFrame = null;
        throw failed;
      }
      if (got.length) {
        await onFrame(got.shift()!, i++);
        continue;
      }
      await new Promise((r) => setImmediate(r));
    }
    await done;
    this.onFrame = null;
  }

  /** one frame at scene time t (seconds, without the hold) */
  frame(t: number): Promise<Buffer> {
    return this.serial(() => this.frameNow(t));
  }
  private async frameNow(t: number): Promise<Buffer> {
    let f: Buffer | null = null;
    this.onFrame = (b) => {
      f = b;
    };
    try {
      await this.call({ cmd: "frame", t });
      while (!f) {
        if (this.dead) throw this.dead;
        await new Promise((r) => setImmediate(r));
      }
    } catch (e) {
      this.onFrame = null;
      throw e;
    }
    this.onFrame = null;
    return f;
  }

  /** a trial render's probe (LoadedProject.probe): what the scene's bundle draws at t, and its draw time in ms */
  probe(t: number): Promise<{ scene: string; boxes: ProbeBox[]; ms: number }> {
    return this.serial(() => this.call({ cmd: "probe", t }));
  }

  async sfxEvents(): Promise<{ t: number; type: string }[]> {
    return (await this.call({ cmd: "sfx" })).events;
  }

  close() {
    this.closed = true;
    this.child.kill();
  }

  /** the sandbox child's pid (a test kills it to check the renderer recovers) */
  get pid() {
    return this.child.pid;
  }
}

export async function openRenderer(p: LoadedProject) {
  const r = new Renderer(p);
  try {
    return await r.start();
  } catch (e) {
    r.close();
    throw e;
  }
}
