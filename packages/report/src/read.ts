// The readers: a project's own files (pitch.json, runs/, assets/, out/) and the ledger, read-only.
// Never reads auth.json, settings.json or anything under the project's private/.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** one line per JSON value; bad lines are skipped, never thrown */
export function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** parse each row, dropping the ones that don't fit */
function rows<T extends z.ZodType>(schema: T, xs: unknown[]): z.infer<T>[] {
  const out: z.infer<T>[] = [];
  for (const x of xs) {
    const r = schema.safeParse(x);
    if (r.success) out.push(r.data);
  }
  return out;
}

const Str = z.string();
const OptStr = z.string().nullish();

const TaskEvent = z.looseObject({
  id: Str,
  kind: OptStr,
  role: OptStr,
  instance: OptStr,
  title: OptStr,
  planTask: OptStr,
  status: OptStr,
  usd: z.number().nullish(),
  model: OptStr,
  startedAt: OptStr,
  endedAt: OptStr,
  summary: OptStr,
  error: z.looseObject({ message: z.string().default(""), kind: OptStr }).nullish(),
});
const Event = z.looseObject({ event: Str, ts: Str, data: z.unknown() });
const Gate = z.looseObject({ id: Str, status: Str, verdict: z.looseObject({ by: OptStr }).nullish() });
const Run = z.looseObject({ id: Str, status: Str });
const Status = z.looseObject({ line: OptStr, problem: z.looseObject({ text: OptStr }).nullish() });

export type Task = {
  id: string;
  kind: string;
  role: string;
  instance: string;
  title: string;
  planTask: string;
  status: string;
  usd: number;
  model: string;
  start: string;
  end: string | null;
  /** the last time the log mentioned it, for a task that never ended */
  seen: string;
  summary: string;
  error: { message: string; kind?: string } | null;
};
export type GateEv = { at: string; id: string; status: string; by: string | null };
export type RunEv = { at: string; id: string; status: string };
export type StatusEv = { at: string; line: string; problem: string | null };

export type Events = { tasks: Task[]; gates: GateEv[]; runs: RunEv[]; statuses: StatusEv[] };

/** runs/events.jsonl: task rows folded by id (the last copy wins, field by field), gates, runs and status lines */
export function readEvents(dir: string): Events {
  const tasks = new Map<string, Task>();
  const gates: GateEv[] = [];
  const runs: RunEv[] = [];
  const statuses: StatusEv[] = [];
  for (const e of rows(Event, readJsonl(join(dir, "runs", "events.jsonl")))) {
    if (e.event === "task") {
      const r = TaskEvent.safeParse(e.data);
      if (!r.success) continue;
      const x = r.data;
      const t: Task = tasks.get(x.id) ?? {
        id: x.id,
        kind: "",
        role: "",
        instance: "",
        title: "",
        planTask: "",
        status: "",
        usd: 0,
        model: "",
        start: x.startedAt ?? e.ts,
        end: null,
        seen: e.ts,
        summary: "",
        error: null,
      };
      t.kind = x.kind ?? t.kind;
      t.role = x.role ?? t.role;
      t.instance = x.instance ?? t.instance;
      t.title = x.title ?? t.title;
      t.planTask = x.planTask ?? t.planTask;
      t.status = x.status ?? t.status;
      t.usd = x.usd ?? t.usd;
      t.model = x.model ?? t.model;
      t.end = x.endedAt ?? t.end;
      t.summary = x.summary ?? t.summary;
      t.seen = e.ts;
      if (x.error) t.error = { message: x.error.message, ...(x.error.kind ? { kind: x.error.kind } : {}) };
      tasks.set(x.id, t);
    } else if (e.event === "gate") {
      const r = Gate.safeParse(e.data);
      if (r.success) gates.push({ at: e.ts, id: r.data.id, status: r.data.status, by: r.data.verdict?.by ?? null });
    } else if (e.event === "run") {
      const r = Run.safeParse(e.data);
      if (r.success) runs.push({ at: e.ts, id: r.data.id, status: r.data.status });
    } else if (e.event === "status") {
      const r = Status.safeParse(e.data);
      if (r.success) statuses.push({ at: e.ts, line: r.data.line ?? "", problem: r.data.problem?.text ?? null });
    }
  }
  return { tasks: [...tasks.values()].sort((a, b) => a.start.localeCompare(b.start)), gates, runs, statuses };
}

const PlanTask = z.looseObject({
  id: Str,
  note: OptStr,
  outcome: OptStr,
  taskIds: z.array(z.string()).default([]),
  status: OptStr,
});
const Revision = z.looseObject({
  rev: z.number(),
  at: Str,
  by: z.string().default(""),
  trigger: z.string().default(""),
  reason: z.string().nullish(),
  ops: z.array(z.looseObject({ op: z.string() })).nullish(),
  estimate: z.looseObject({ usd: z.tuple([z.number(), z.number()]).nullish() }).nullish(),
  tasks: z.array(PlanTask).default([]),
});
export type Revision = z.infer<typeof Revision>;

/** every plan revision (runs/plan.jsonl), and the current plan (runs/plan.json) as the last one when it is newer */
export function readPlan(dir: string): Revision[] {
  const revs = rows(Revision, readJsonl(join(dir, "runs", "plan.jsonl")));
  const cur = Revision.safeParse(readJson(join(dir, "runs", "plan.json")));
  if (cur.success && !revs.some((r) => r.rev === cur.data.rev)) revs.push(cur.data);
  else if (cur.success) revs[revs.findIndex((r) => r.rev === cur.data.rev)] = cur.data;
  return revs.sort((a, b) => a.rev - b.rev);
}

const Card = z.looseObject({ title: OptStr });
const PipItem = z.looseObject({
  id: Str,
  at: Str,
  kind: Str,
  text: z.string().default(""),
  cards: z.array(Card).nullish(),
});
export type PipItem = { id: string; at: string; kind: string; text: string; cards: string[] };

/** Pip's thread (runs/pip.jsonl): the last copy of each item (cards are rewritten in place). Only text and card titles. */
export function readPip(dir: string): PipItem[] {
  const seen = new Map<string, PipItem>();
  for (const i of rows(PipItem, readJsonl(join(dir, "runs", "pip.jsonl"))))
    seen.set(i.id, {
      id: i.id,
      at: i.at,
      kind: i.kind,
      text: i.text,
      cards: (i.cards ?? []).map((c) => c.title ?? "").filter(Boolean),
    });
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
}

const Channel = z.looseObject({
  at: Str,
  from: z.string().default(""),
  kind: z.string().default(""),
  text: z.string().default(""),
  ref: OptStr,
});
export type ChannelMsg = { at: string; from: string; kind: string; text: string; ref: string | null };

/** the crew's channel (runs/channel.jsonl) */
export function readChannel(dir: string): ChannelMsg[] {
  return rows(Channel, readJsonl(join(dir, "runs", "channel.jsonl"))).map((m) => ({
    at: m.at,
    from: m.from,
    kind: m.kind,
    text: m.text,
    ref: m.ref ?? null,
  }));
}

const Flags = z.looseObject({
  private: z.boolean().nullish(),
  likeness: z.unknown().optional(),
  brand: z.unknown().optional(),
});
const Pitch = z.looseObject({
  id: z.string().optional(),
  title: z.string().default(""),
  brief: z.looseObject({ idea: z.string().default("") }).nullish(),
  budget: z.looseObject({ capUsd: z.number().nullish() }).nullish(),
  scenes: z.array(z.looseObject({ id: z.string() })).nullish(),
  assets: z.array(z.looseObject({ id: z.string(), src: z.string().default(""), flags: Flags.nullish() })).nullish(),
  delivery: z.array(z.looseObject({ out: z.string() })).nullish(),
});
export type Pitch = {
  id: string;
  title: string;
  idea: string;
  capUsd: number | null;
  sceneIds: string[];
  assets: { id: string; src: string; private: boolean }[];
  deliveries: string[];
};

export function readPitch(dir: string, fallbackId: string): Pitch {
  const r = Pitch.safeParse(readJson(join(dir, "pitch.json")));
  if (!r.success)
    throw Object.assign(new Error(`no readable pitch.json in ${dir}`), { fix: "pass a project folder or id" });
  const d = r.data;
  return {
    id: d.id ?? fallbackId,
    title: d.title,
    idea: d.brief?.idea ?? "",
    capUsd: d.budget?.capUsd ?? null,
    sceneIds: (d.scenes ?? []).map((s) => s.id),
    assets: (d.assets ?? []).map((a) => ({
      id: a.id,
      src: a.src,
      private: !!(a.flags?.private || a.flags?.likeness || a.flags?.brand),
    })),
    deliveries: (d.delivery ?? []).map((x) => x.out),
  };
}

const AssetFile = z.looseObject({
  id: Str,
  kind: z.string().default(""),
  w: z.number().default(0),
  h: z.number().default(0),
  frames: z.array(z.string()).default([]),
  description: z.string().default(""),
  rights: z
    .looseObject({ likeness: z.boolean().nullish(), brand: z.boolean().nullish(), trademark: z.boolean().nullish() })
    .nullish(),
});
export type AssetFile = {
  id: string;
  kind: string;
  w: number;
  h: number;
  frames: number;
  description: string;
  private: boolean;
  /** the sheet next to it, when there is one */
  png: string | null;
};

/** the project's own assets (assets/<name>.json and its .png) */
export function readAssets(dir: string): AssetFile[] {
  const d = join(dir, "assets");
  if (!existsSync(d)) return [];
  const out: AssetFile[] = [];
  for (const f of readdirSync(d).sort()) {
    if (!f.endsWith(".json")) continue;
    const r = AssetFile.safeParse(readJson(join(d, f)));
    if (!r.success) continue;
    const a = r.data;
    const png = join(d, f.replace(/\.json$/, ".png"));
    out.push({
      id: a.id,
      kind: a.kind,
      w: a.w,
      h: a.h,
      frames: a.frames.length,
      description: a.description,
      private: !!(a.rights?.likeness || a.rights?.brand || a.rights?.trademark),
      png: existsSync(png) ? png : null,
    });
  }
  return out;
}

/** every drawn variant: runs/<asset>-v<n>.png */
export function readVariants(dir: string): { asset: string; variant: number; path: string }[] {
  const d = join(dir, "runs");
  if (!existsSync(d)) return [];
  const out: { asset: string; variant: number; path: string }[] = [];
  for (const f of readdirSync(d).sort()) {
    const m = /^([a-z0-9][a-z0-9_-]*?)-v(\d+)\.png$/.exec(f);
    if (m) out.push({ asset: m[1], variant: Number(m[2]), path: join(d, f) });
  }
  return out.sort((a, b) => a.asset.localeCompare(b.asset) || a.variant - b.variant);
}

/** true when the file really lives inside the project and outside its private/ (symlinks resolved) */
export function safeImage(dir: string, path: string): boolean {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(path);
    if (!real.startsWith(root + sep)) return false;
    return !real
      .slice(root.length + 1)
      .split(sep)
      .includes("private");
  } catch {
    return false;
  }
}

export type Call = {
  ts: string;
  project: string;
  task: string;
  taskKind: string;
  role: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  usd: number;
  durationMs: number;
  stop: string;
};

/**
 * The ledger's calls, read-only (packages/crew/src/llm/ledger.ts writes them). Only the columns that exist are read,
 * so an older ledger works too. A missing ledger is no calls.
 */
export function readLedger(path: string): Call[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const cols = new Set((db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.size) return [];
    const col = (name: string, fallback: string) => (cols.has(name) ? name : `${fallback} AS ${name}`);
    const sql = `SELECT ${[
      col("ts", "''"),
      col("project", "''"),
      col("task", "''"),
      col("task_kind", "''"),
      col("role", "''"),
      col("model", "''"),
      col("prompt_version", "''"),
      col("input_tokens", "0"),
      col("output_tokens", "0"),
      col("thinking_tokens", "0"),
      col("usd", "0"),
      col("duration_ms", "0"),
      col("stop", "''"),
    ].join(", ")} FROM calls ORDER BY ts, ${cols.has("id") ? "id" : "rowid"}`;
    return (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({
      ts: String(r.ts ?? ""),
      project: String(r.project ?? ""),
      task: String(r.task ?? ""),
      taskKind: String(r.task_kind ?? ""),
      role: String(r.role ?? ""),
      model: String(r.model ?? ""),
      promptVersion: String(r.prompt_version ?? ""),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      thinkingTokens: Number(r.thinking_tokens ?? 0),
      usd: Number(r.usd ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      stop: String(r.stop ?? ""),
    }));
  } finally {
    db.close();
  }
}

const Pick = z.looseObject({
  project: z.string().default(""),
  where: z.string().default(""),
  options: z.array(z.string()).nullish(),
  chose: z.string().default(""),
  why: z.string().default(""),
  by: OptStr,
});
export type Pick = { project: string; where: string; options: string[]; chose: string; why: string; by: string | null };

/** picks.jsonl, the person's (or a stand-in's) picks during the run, in file order */
export function readPicks(path: string): Pick[] {
  return rows(Pick, readJsonl(path)).map((p) => ({
    project: p.project,
    where: p.where,
    options: p.options ?? [],
    chose: p.chose,
    why: p.why,
    by: p.by ?? null,
  }));
}
