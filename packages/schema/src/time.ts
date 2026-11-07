// Time expressions: every time in a project hangs off the script cues, so re-timing to a voiceover moves everything.
//   S(c03)  start of cue c03          E(c03)  end of cue c03          @join_land   a named event
//   intro.from / intro.to  a scene's window      hold, endHold, duration
//   + - * /, parentheses, unary minus, min(a, b, ...), max(a, b, ...)
// Arithmetic is plain IEEE doubles evaluated left to right, so "E(c01)+0.1" equals the hand-written E(0) + 0.1.
import type { ProjectT } from "./doc.ts";

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

export class TimeError extends Error {
  readonly fix?: string;
  constructor(message: string, fix?: string) {
    super(message);
    this.fix = fix;
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new TimeError(`bad number at "${src.slice(i)}"`);
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_@]/.test(c)) {
      const m = /^@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i));
      if (!m) throw new TimeError(`bad name at "${src.slice(i)}"`);
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new TimeError(`unexpected "${c}" in time expression "${src}"`);
  }
  return out;
}

export type Node =
  | { t: "num"; v: number }
  | { t: "ref"; name: string }
  | { t: "call"; fn: string; args: Node[] }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node };

export function parseTime(src: string | number): Node {
  if (typeof src === "number") return { t: "num", v: src };
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p++];
    if (!t || (v && t.v !== v)) throw new TimeError(`expected "${v ?? "a value"}" in "${src}"`);
    return t;
  };
  function primary(): Node {
    const t = eat();
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "op" && t.v === "(") {
      const e = expr();
      eat(")");
      return e;
    }
    if (t.k === "op" && t.v === "-") return { t: "neg", a: primary() };
    if (t.k === "id") {
      if (peek()?.v === "(") {
        eat("(");
        const args: Node[] = [];
        if (peek()?.v !== ")") {
          args.push(expr());
          while (peek()?.v === ",") {
            eat(",");
            args.push(expr());
          }
        }
        eat(")");
        if (!["S", "E", "min", "max"].includes(t.v))
          throw new TimeError(`unknown function ${t.v}()`, "use S(cue), E(cue), min(...) or max(...)");
        return { t: "call", fn: t.v, args };
      }
      return { t: "ref", name: t.v };
    }
    throw new TimeError(`unexpected "${t.v}" in "${src}"`);
  }
  function term(): Node {
    let a = primary();
    while (peek()?.v === "*" || peek()?.v === "/") {
      const op = eat().v as string;
      a = { t: "bin", op, a, b: primary() };
    }
    return a;
  }
  function expr(): Node {
    let a = term();
    while (peek()?.v === "+" || peek()?.v === "-") {
      const op = eat().v as string;
      a = { t: "bin", op, a, b: term() };
    }
    return a;
  }
  const e = expr();
  if (p !== toks.length) throw new TimeError(`unexpected "${toks[p].v}" in "${src}"`);
  return e;
}

/** cue id -> [start, end]; from the aligned narration, or estimated from words per second */
export function cueTimes(script: ProjectT["script"]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const { timing } = script;
  if (timing.mode === "aligned") {
    for (const c of script.cues) {
      const span = timing.aligned?.[c.id];
      if (!span)
        throw new TimeError(`cue ${c.id} has no aligned time`, "re-run vo_align or switch timing.mode to estimate");
      out.set(c.id, [span[0], span[1]]);
    }
    return out;
  }
  let t = timing.lead;
  for (const c of script.cues) {
    const words = c.text.split(/\s+/).length;
    const d = Math.max(timing.minCue, words / timing.wps);
    out.set(c.id, [t, t + d]);
    t += d + timing.pause;
  }
  return out;
}

export type Timeline = {
  cues: { id: string; text: string; start: number; end: number }[];
  hold: number;
  endHold: number;
  duration: number;
  scenes: { id: string; from: number; to: number }[];
  events: Record<string, number>;
  /** evaluate any expression against this timeline */
  at: (e: string | number) => number;
};

/** Resolve every time in the project. Throws TimeError with a fix hint on an unknown name or a cycle. */
export function resolveTimeline(doc: Pick<ProjectT, "script" | "composition" | "scenes" | "events">): Timeline {
  const cues = cueTimes(doc.script);
  const memo = new Map<string, number>();
  const busy = new Set<string>();
  const sceneIds = new Set(doc.scenes.map((s) => s.id));
  const cueList = [...cues.keys()];

  const cue = (n: Node, edge: 0 | 1): number => {
    if (n.t !== "ref") throw new TimeError("S() and E() take a cue id", `valid cues: ${cueList.join(", ")}`);
    const span = cues.get(n.name);
    if (!span) throw new TimeError(`unknown cue ${n.name}`, `valid cues: ${cueList.join(", ")}`);
    return span[edge];
  };
  const named = (key: string, src: () => string | number): number => {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (busy.has(key))
      throw new TimeError(`time cycle through ${key}`, "make one of these times depend on a cue instead");
    busy.add(key);
    const v = ev(parseTime(src()));
    busy.delete(key);
    memo.set(key, v);
    return v;
  };
  function ref(name: string): number {
    if (name === "hold") return doc.composition.hold;
    if (name === "endHold") return doc.composition.endHold;
    if (name === "duration") return named("duration", () => doc.composition.duration);
    if (name.startsWith("@")) {
      const id = name.slice(1);
      const src = doc.events[id];
      if (src === undefined)
        throw new TimeError(`unknown event @${id}`, `valid events: ${Object.keys(doc.events).join(", ") || "(none)"}`);
      return named(name, () => src);
    }
    const dot = name.indexOf(".");
    if (dot > 0) {
      const [sid, edge] = [name.slice(0, dot), name.slice(dot + 1)];
      const sc = doc.scenes.find((s) => s.id === sid);
      if (!sc || (edge !== "from" && edge !== "to"))
        throw new TimeError(
          `unknown scene time ${name}`,
          `use <scene>.from or <scene>.to; scenes: ${[...sceneIds].join(", ")}`,
        );
      return named(name, () => sc[edge]);
    }
    throw new TimeError(`unknown name ${name}`, "use S(cue), E(cue), @event, <scene>.from, hold, endHold or duration");
  }
  function ev(n: Node): number {
    switch (n.t) {
      case "num":
        return n.v;
      case "ref":
        return ref(n.name);
      case "neg":
        return -ev(n.a);
      case "bin": {
        const a = ev(n.a);
        const b = ev(n.b);
        return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : a / b;
      }
      case "call":
        if (n.fn === "S" || n.fn === "E") {
          if (n.args.length !== 1) throw new TimeError(`${n.fn}() takes one cue id`);
          return cue(n.args[0], n.fn === "S" ? 0 : 1);
        }
        if (!n.args.length) throw new TimeError(`${n.fn}() needs at least one value`);
        return n.fn === "min" ? Math.min(...n.args.map(ev)) : Math.max(...n.args.map(ev));
    }
  }
  const duration = ref("duration");
  const scenes = doc.scenes.map((s) => ({ id: s.id, from: ref(`${s.id}.from`), to: ref(`${s.id}.to`) }));
  const events = Object.fromEntries(Object.keys(doc.events).map((k) => [k, ref(`@${k}`)]));
  return {
    cues: doc.script.cues.map((c) => {
      const [start, end] = cues.get(c.id)!;
      return { id: c.id, text: c.text, start, end };
    }),
    hold: doc.composition.hold,
    endHold: doc.composition.endHold,
    duration,
    scenes,
    events,
    at: (e) => ev(parseTime(e)),
  };
}

/** names an expression refers to, for lints ("raw seconds") and dependency views */
export function refsOf(src: string | number): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.t === "ref") out.push(n.name);
    else if (n.t === "call") {
      if ((n.fn === "S" || n.fn === "E") && n.args[0]?.t === "ref") out.push(`${n.fn}(${n.args[0].name})`);
      else n.args.forEach(walk);
    } else if (n.t === "neg") walk(n.a);
    else if (n.t === "bin") {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(parseTime(src));
  return out;
}
