// Host side of the render sandbox: starts sandbox-child.ts with Node's permission model and streams frames back.
import { type ChildProcess, fork } from "node:child_process";
import { compileDecl } from "@pap/engine/decl";
import { type LoadedProject, PAP_ROOT, timelineModule } from "./project.ts";
import type { InitMsg } from "./sandbox-child.ts";

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
  private child: ChildProcess;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private seq = 0;
  private buf: Buffer = Buffer.alloc(0);
  private onFrame: ((f: Buffer) => void | Promise<void>) | null = null;
  private ready: Promise<void>;
  readonly project: LoadedProject;

  constructor(project: LoadedProject) {
    this.project = project;
    this.child = fork(new URL("./sandbox-child.ts", import.meta.url).pathname, [], {
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
    this.child.stdout!.on("data", (chunk: Buffer) => {
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
    this.child.on("message", (m: any) => {
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
    this.child.on("exit", (code) => {
      const err = new Error(`render sandbox exited (${code})`);
      readyRej(err);
      for (const p of this.pending.values()) p.rej(err);
      this.pending.clear();
    });
  }

  private call(msg: any, id = ++this.seq): Promise<any> {
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.child.send(id === -1 ? msg : { ...msg, id });
    });
  }

  async start() {
    await this.ready;
    await this.call(initMessage(this.project), -1);
    return this;
  }

  /** frames [from, to) in order; onFrame gets each raw RGB frame */
  async frames(from: number, to: number, onFrame: (f: Buffer, i: number) => void | Promise<void>) {
    let i = from;
    const got: Buffer[] = [];
    this.onFrame = (f) => {
      got.push(f);
    };
    const done = this.call({ cmd: "frames", from, to, fps: FPS, hold: this.project.timeline.hold });
    // deliver in order as they arrive
    while (i < to) {
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
  async frame(t: number): Promise<Buffer> {
    let f: Buffer | null = null;
    this.onFrame = (b) => {
      f = b;
    };
    await this.call({ cmd: "frame", t });
    while (!f) await new Promise((r) => setImmediate(r));
    this.onFrame = null;
    return f;
  }

  async sfxEvents(): Promise<{ t: number; type: string }[]> {
    return (await this.call({ cmd: "sfx" })).events;
  }

  close() {
    this.child.kill();
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
