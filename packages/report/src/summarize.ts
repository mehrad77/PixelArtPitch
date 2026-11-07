// The project's files -> the summary the page draws: lanes, your waits, Pip's turns, plan revisions, incidents,
// cost by role and project, thinking against answer, the failure matrix, the new assets. Deterministic: the same files
// give the same summary (times are seconds from the first mark, numbers are rounded).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROLE_LABEL } from "@pap/crew/plan/catalogue";
import { Role } from "@pap/schema";
import { type Findings, parseFindings } from "./findings.ts";
import { errorKind, FAIL_KINDS, FAIL_LABEL, type FailKind, fallbackKind, INCIDENT_LABEL } from "./kinds.ts";
import {
  type Call,
  type Pick,
  readAssets,
  readChannel,
  readEvents,
  readLedger,
  readPicks,
  readPip,
  readPitch,
  readPlan,
  readVariants,
  safeImage,
  type Task,
} from "./read.ts";

export type ReportOptions = {
  /** one run's window (`run_…`); every run when left out */
  run?: string;
  /** the ledger; `$PAP_HOME/ledger.sqlite` by default */
  ledger?: string;
  /** findings.md to show as the findings section */
  notes?: string;
  /** picks.jsonl to show as the picks section */
  picks?: string;
  /** show the images of assets flagged private, likeness or brand (and the contact sheets made with them) */
  includePrivate?: boolean;
};

export type Bar = {
  s: number;
  e: number;
  state: "work" | "fallback" | "failed";
  title: string;
  usd: number;
  model: string;
  why: string;
};
export type Lane = { name: string; role: string; bars: Bar[] };
export type AssetCard = {
  id: string;
  kind: string;
  size: string;
  frames: number;
  kept: boolean;
  private: boolean;
  images: { file: string; label: string }[];
  tags: [string, "good" | "warn" | "bad" | ""][];
  description: string;
  usd: number;
  calls: number;
  sec: number;
  limit: number;
};
export type Summary = {
  project: { id: string; title: string; idea: string; capUsd: number | null };
  window: { run: string | null; runs: { id: string; status: string; s: number; e: number | null }[] };
  t0: number;
  date: string;
  dur: number;
  total: number;
  ncalls: number;
  stats: [string, string][];
  exported: string[];
  outputs: { file: string; label: string; private: boolean }[];
  assets: AssetCard[];
  lanes: Lane[];
  you: { s: number; e: number; title: string }[];
  pipDots: { t: number; kind: string; text: string; cards: string[] }[];
  revs: {
    t: number;
    rev: number;
    by: string;
    trigger: string;
    reason: string;
    adds: number;
    est: [number, number] | null;
    spent: number;
  }[];
  incidents: { t: number; kind: string; label: string }[];
  byRole: {
    role: string;
    label: string;
    usd: number;
    sec: number;
    n: number;
    limit: number;
    think: number;
    answer: number;
  }[];
  byProject: { project: string; usd: number; n: number; self: boolean }[];
  thinking: {
    role: string;
    label: string;
    share: number;
    calls: {
      what: string;
      kind: string;
      think: number;
      answer: number;
      sec: number;
      usd: number;
      stop: string;
      model: string;
    }[];
  } | null;
  fail: {
    kinds: { kind: FailKind; label: string }[];
    rows: { role: string; label: string; counts: Partial<Record<FailKind, number>> }[];
  };
  couldnt: { t: number; from: string; text: string }[];
  picks: Pick[] | null;
  findings: Findings | null;
};
export type ImageRef = { name: string; src: string };

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const sec = (iso: string) => Date.parse(iso) / 1000;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const usd = (n: number) => `$${n.toFixed(2)}`;
const ROLES: string[] = Role.options;
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r;
const roleRank = (r: string) => {
  if (r === "assistant") return -1;
  const i = ROLES.indexOf(r);
  return i < 0 ? ROLES.length : i;
};
const model = (m: string) => m.split("/").pop() ?? m;

/** keys and tokens never reach the page, nor the folders on this machine */
export function redact(s: string, dir: string): string {
  let out = s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [key]")
    .replace(
      /((?:x-api-key|api[_-]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
      "$1[key]",
    )
    .replace(/\b[a-f0-9]{32,}\b/gi, "[hex]")
    .replace(
      /(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])[A-Za-z0-9+_-]{40,}={0,2}/g,
      "[redacted]",
    );
  if (dir) out = out.split(dir).join("<project>");
  const home = homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  return out;
}
function redactDeep<T>(x: T, dir: string): T {
  if (typeof x === "string") return redact(x, dir) as T;
  if (Array.isArray(x)) return x.map((v) => redactDeep(v, dir)) as T;
  if (x && typeof x === "object")
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, redactDeep(v, dir)])) as T;
  return x;
}

export function summarize(dir: string, opts: ReportOptions = {}): { summary: Summary; images: ImageRef[] } {
  const pitch = readPitch(dir, dir.split("/").pop() ?? "project");
  const ev = readEvents(dir);
  const plan = readPlan(dir);
  const pipAll = readPip(dir);
  const channel = readChannel(dir);
  const home = process.env.PAP_HOME || join(homedir(), ".pixelartpitch");
  const ledgerAll = readLedger(opts.ledger ?? join(home, "ledger.sqlite"));

  // ---- the window: one run, or all of them ----
  const runIds = [...new Set(ev.runs.map((r) => r.id))];
  const runs = runIds.map((id) => {
    const start = ev.runs.find((r) => r.id === id && r.status === "start") ?? ev.runs.find((r) => r.id === id)!;
    const end = ev.runs.find((r) => r.id === id && r.status !== "start" && r.at >= start.at) ?? null;
    return { id, status: end?.status ?? "running", from: start.at, to: end?.at ?? null };
  });
  let from = "";
  let to = "\uffff";
  if (opts.run) {
    const w = runs.find((r) => r.id === opts.run);
    if (!w)
      throw Object.assign(new Error(`no run ${opts.run} in this project`), {
        fix: runs.length ? `use one of: ${runs.map((r) => r.id).join(", ")}, or --all` : "leave out --run",
      });
    from = w.from;
    to = w.to ?? "\uffff";
  }
  const inWin = (at: string) => at >= from && at <= to;

  const tasks = ev.tasks.filter((t) => inWin(t.start));
  const pip = pipAll.filter((i) => inWin(i.at));
  const calls = ledgerAll.filter((c) => c.project === pitch.id && inWin(c.ts));
  const marks = [...tasks.map((t) => sec(t.start)), ...pip.map((i) => sec(i.at))];
  const ends = [...tasks.map((t) => sec(t.end ?? t.seen)), ...pip.map((i) => sec(i.at))];
  const t0 = marks.length ? Math.min(...marks) : from ? sec(from) : 0;
  const tEnd = ends.length ? Math.max(...ends) : t0;
  const rel = (iso: string) => r1(sec(iso) - t0);

  // ---- fallbacks: a plan task whose note says "partial: …" (or whose outcome is a fallback), in any revision ----
  const partial = new Map<string, string>(); // task id -> note
  const partialPlan = new Map<string, string>(); // plan task id -> note
  for (const r of plan) {
    if (r.at > to) continue;
    for (const p of r.tasks) {
      const note = p.note ?? "";
      if (!(note.startsWith("partial") || p.outcome === "fallback")) continue;
      partialPlan.set(p.id, note || "fell back");
      for (const id of p.taskIds) partial.set(id, note || "fell back");
    }
  }
  const noteOf = (t: Task) => partial.get(t.id) ?? (t.planTask ? partialPlan.get(t.planTask) : undefined);
  /** a task's failure kind, if it failed or fell back */
  const kindOf = (t: Task): FailKind | null => {
    const note = noteOf(t);
    if (t.error) {
      const k = errorKind(t.error.message, t.error.kind);
      if (k && !(k === "other" && note)) return k;
    }
    if (note) return fallbackKind(note);
    return null;
  };

  // ---- lanes, one per crew instance ----
  const subjectOf = (t: Task) => (t.instance.includes(":") ? t.instance.split(":")[1] : "");
  const laneKey = (t: Task) => t.instance || t.role || "?";
  const laneName = (t: Task) => {
    const s = subjectOf(t);
    return s
      ? `${roleLabel(t.role || t.instance.split(":")[0])} · ${s.replace(/_/g, " ")}`
      : roleLabel(t.role || laneKey(t));
  };
  const lanesMap = new Map<string, Lane & { first: number; scene: number }>();
  for (const t of tasks) {
    if (t.role === "person" || t.kind === "gate") continue;
    const key = laneKey(t);
    const s = r1(sec(t.start) - t0);
    const e = r1((t.end ? sec(t.end) : Math.max(sec(t.seen), sec(t.start) + 1)) - t0);
    const note = noteOf(t);
    const state: Bar["state"] = t.status === "failed" ? "failed" : note ? "fallback" : "work";
    const why = t.error?.message || note || t.summary || "";
    let lane = lanesMap.get(key);
    if (!lane) {
      const subject = subjectOf(t);
      lane = {
        name: laneName(t),
        role: t.role || key.split(":")[0],
        bars: [],
        first: s,
        scene: t.role === "animator" && subject ? pitch.sceneIds.indexOf(subject) : -1,
      };
      lanesMap.set(key, lane);
    }
    lane.bars.push({
      s,
      e: r1(Math.max(e, s + 2)),
      state,
      title: t.title || t.kind,
      usd: r3(t.usd),
      model: model(t.model),
      why: cut(why, 220),
    });
  }
  const lanes: Lane[] = [...lanesMap.values()]
    .sort(
      (a, b) =>
        roleRank(a.role) - roleRank(b.role) ||
        (a.scene >= 0 && b.scene >= 0 ? a.scene - b.scene : 0) ||
        a.first - b.first ||
        a.name.localeCompare(b.name),
    )
    .map(({ name, role, bars }) => ({ name, role, bars: bars.sort((x, y) => x.s - y.s) }));

  // ---- the person's waits: a gate from open until it passed ----
  const you: Summary["you"] = [];
  const open = new Map<string, string>();
  for (const g of ev.gates) {
    if (!inWin(g.at)) continue;
    if (g.status === "open") {
      if (!open.has(g.id)) open.set(g.id, g.at);
    } else if (open.has(g.id) && g.status !== "open") {
      you.push({ s: rel(open.get(g.id)!), e: rel(g.at), title: `Gate ${g.id}` });
      open.delete(g.id);
    }
  }
  you.sort((a, b) => a.s - b.s);

  const pipDots = pip.map((i) => ({ t: rel(i.at), kind: i.kind, text: cut(i.text, 260), cards: i.cards }));

  // ---- plan revisions, priced against what had been spent by then ----
  const projCalls = ledgerAll.filter((c) => c.project === pitch.id);
  const spentBy = (at: string) => r3(projCalls.filter((c) => c.ts <= at).reduce((a, c) => a + c.usd, 0));
  const revs = plan
    .filter((r) => inWin(r.at))
    .map((r) => ({
      t: rel(r.at),
      rev: r.rev,
      by: r.by,
      trigger: r.trigger,
      reason: cut(r.reason ?? "", 200),
      adds: (r.ops ?? []).filter((o) => o.op === "add").length,
      est: r.estimate?.usd ? ([r3(r.estimate.usd[0]), r3(r.estimate.usd[1])] as [number, number]) : null,
      spent: spentBy(r.at),
    }));

  // ---- incidents: the first of each provider or standard failure, and every failed run ----
  const incidents: Summary["incidents"] = [];
  const seenKind = new Set<string>();
  for (const t of [...tasks].sort((a, b) => (a.end ?? a.seen).localeCompare(b.end ?? b.seen))) {
    const k = kindOf(t);
    if (!k || !INCIDENT_LABEL[k] || seenKind.has(k)) continue;
    seenKind.add(k);
    incidents.push({ t: rel(t.end ?? t.seen), kind: k, label: INCIDENT_LABEL[k]! });
  }
  for (const r of runs) {
    if (r.status !== "failed" || !r.to || !inWin(r.to)) continue;
    const problem = [...ev.statuses].reverse().find((s) => s.at <= r.to! && s.problem)?.problem;
    incidents.push({ t: rel(r.to), kind: "run", label: problem ? `Run failed: ${cut(problem, 80)}` : "Run failed" });
  }
  incidents.sort((a, b) => a.t - b.t);

  // ---- cost and time by role, and by project over the same time ----
  const roleRows = new Map<string, Summary["byRole"][number]>();
  for (const c of calls) {
    const r = roleRows.get(c.role) ?? {
      role: c.role,
      label: roleLabel(c.role),
      usd: 0,
      sec: 0,
      n: 0,
      limit: 0,
      think: 0,
      answer: 0,
    };
    roleRows.set(c.role, r);
    r.usd += c.usd;
    r.sec += c.durationMs / 1000;
    r.n++;
    r.limit += c.stop === "max_tokens" ? 1 : 0;
    r.think += c.thinkingTokens;
    r.answer += Math.max(0, c.outputTokens - c.thinkingTokens);
  }
  const byRole = [...roleRows.values()]
    .map((r) => ({ ...r, usd: r3(r.usd), sec: r1(r.sec) }))
    .sort((a, b) => b.usd - a.usd || a.role.localeCompare(b.role));
  const total = r3(calls.reduce((a, c) => a + c.usd, 0));
  const lo = new Date(t0 * 1000).toISOString();
  const hi = new Date(tEnd * 1000).toISOString();
  const projRows = new Map<string, { project: string; usd: number; n: number; self: boolean }>();
  for (const c of ledgerAll) {
    if (c.ts < lo || c.ts > hi) continue;
    const p = projRows.get(c.project) ?? { project: c.project, usd: 0, n: 0, self: c.project === pitch.id };
    projRows.set(c.project, p);
    p.usd += c.usd;
    p.n++;
  }
  const byProject = [...projRows.values()].map((p) => ({ ...p, usd: r3(p.usd) })).sort((a, b) => b.usd - a.usd);

  // ---- thinking against answer, call by call, for the role that thought the most ----
  const taskById = new Map(ev.tasks.map((t) => [t.id, t]));
  const thinker = [...roleRows.values()].filter((r) => r.think > 0).sort((a, b) => b.think - a.think)[0];
  const callWhat = (c: Call) => {
    const t = taskById.get(c.task);
    if (!t) return c.taskKind;
    const s = subjectOf(t).replace(/_/g, " ");
    const v = /_v(\d+)$/.exec(t.planTask)?.[1];
    return s ? `${s}${v ? ` v${v}` : ""}` : cut(t.title || c.taskKind, 28);
  };
  const thinking: Summary["thinking"] = thinker
    ? {
        role: thinker.role,
        label: thinker.label,
        share: Math.round((thinker.think / Math.max(1, thinker.think + thinker.answer)) * 100),
        calls: calls
          .filter((c) => c.role === thinker.role)
          .map((c) => ({
            what: callWhat(c),
            kind: /\/([a-z0-9_-]+)(@|$)/i.exec(c.promptVersion)?.[1] ?? c.taskKind.split(".").pop() ?? c.taskKind,
            think: c.thinkingTokens,
            answer: Math.max(0, c.outputTokens - c.thinkingTokens),
            sec: Math.round(c.durationMs / 1000),
            usd: r3(c.usd),
            stop: c.stop,
            model: model(c.model),
          })),
      }
    : null;

  // ---- failures: role x kind ----
  const failRows = new Map<string, Partial<Record<FailKind, number>>>();
  const bump = (role: string, k: FailKind) => {
    const row = failRows.get(role) ?? {};
    row[k] = (row[k] ?? 0) + 1;
    failRows.set(role, row);
  };
  for (const c of calls) if (c.stop === "max_tokens") bump(c.role, "limit");
  for (const t of tasks) {
    const k = kindOf(t);
    // a task that ran out of tokens is already counted by its calls above; it fell back if it has a note
    const kk = k === "limit" ? (noteOf(t) ? "fallback" : null) : k;
    if (kk) bump(t.role || laneKey(t), kk);
  }
  const present = new Set([...failRows.values()].flatMap((r) => Object.keys(r)));
  const fail: Summary["fail"] = {
    kinds: FAIL_KINDS.filter((k) => present.has(k)).map((k) => ({ kind: k, label: FAIL_LABEL[k] })),
    rows: [...failRows.entries()]
      .sort((a, b) => roleRank(a[0]) - roleRank(b[0]))
      .map(([role, counts]) => ({ role, label: roleLabel(role), counts })),
  };

  // ---- the new assets: the project's own and every drawn variant ----
  const images: ImageRef[] = [];
  const addImage = (name: string, src: string) => {
    if (!safeImage(dir, src)) return null;
    if (!images.some((i) => i.name === name)) images.push({ name, src });
    return name;
  };
  const files = readAssets(dir);
  // a variant that resolves outside the project or into private/ is not shown, not even by name
  const variants = readVariants(dir).filter((v) => safeImage(dir, v.path));
  const names = [...new Set([...files.map((f) => f.id), ...variants.map((v) => v.asset)])];
  const firstAt = (n: string) => tasks.find((t) => t.instance === `pixel-artist:${n}`)?.start ?? "\uffff";
  names.sort((a, b) => firstAt(a).localeCompare(firstAt(b)) || a.localeCompare(b));
  const anyPrivate = pitch.assets.some((a) => a.private) || files.some((f) => f.private);
  const assets: AssetCard[] = [];
  for (const name of names) {
    const file = files.find((f) => f.id === name);
    const ref = pitch.assets.find((a) => a.id === name);
    const priv = !!(file?.private || ref?.private);
    const show = !priv || !!opts.includePrivate;
    const vs = variants.filter((v) => v.asset === name);
    const drew = tasks.filter((t) => t.instance === `pixel-artist:${name}`);
    const ids = new Set(drew.map((t) => t.id));
    const cs = calls.filter((c) => ids.has(c.task));
    const tags: AssetCard["tags"] = [];
    if (file) tags.push(["Kept in the project", "good"]);
    else if (ref?.src.startsWith("lib:")) tags.push([`Not kept: ${ref.src.slice(4)} stands in`, ""]);
    else tags.push(["Not kept", "bad"]);
    if (priv) tags.push(["Private", "warn"]);
    for (const t of drew) {
      const k = kindOf(t);
      if (!k) continue;
      const v = /_v(\d+)$/.exec(t.planTask)?.[1];
      tags.push([`${v ? `Variant ${v}` : "A draw"}: ${FAIL_LABEL[k].toLowerCase()}`, "bad"]);
    }
    const publish = plan.at(-1)?.tasks.find((p) => p.id === `t_publish_${name}`)?.note;
    if (publish) tags.push([`Publish: ${cut(publish, 40)}`, ""]);
    const imgs: AssetCard["images"] = [];
    if (show) {
      if (file?.png) {
        const n = addImage(`img/asset-${name}.png`, file.png);
        if (n) imgs.push({ file: n, label: `${name}, kept` });
      } else
        for (const v of vs) {
          const n = addImage(`img/${name}-v${v.variant}.png`, v.path);
          if (n) imgs.push({ file: n, label: `${name}, variant ${v.variant}` });
        }
    }
    assets.push({
      id: name,
      kind: file?.kind ?? "",
      size: file ? `${file.w}×${file.h}` : "",
      frames: file?.frames ?? 0,
      kept: !!file,
      private: priv,
      images: imgs,
      tags,
      description: show ? cut(file?.description ?? "", 400) : "",
      usd: r3(cs.reduce((a, c) => a + c.usd, 0)),
      calls: cs.length,
      sec: r1(cs.reduce((a, c) => a + c.durationMs / 1000, 0)),
      limit: cs.filter((c) => c.stop === "max_tokens").length,
    });
  }

  // ---- what came out: the contact sheets (never anything else under out/) ----
  const outputs: Summary["outputs"] = [];
  for (const [f, label] of [
    ["contact.png", "The last cut, one frame per scene"],
    ["animatic-contact.png", "The animatic, before any art was drawn"],
  ] as const) {
    const src = join(dir, "out", f);
    if (!safeImage(dir, src)) continue;
    if (anyPrivate && !opts.includePrivate) {
      outputs.push({ file: "", label, private: true });
      continue;
    }
    const n = addImage(`img/${f}`, src);
    if (n) outputs.push({ file: n, label, private: anyPrivate });
  }
  const exported = pitch.deliveries.filter((f) => safeImage(dir, join(dir, "out", f)));

  // ---- what the crew said it couldn't do ----
  const couldnt: Summary["couldnt"] = [];
  for (const m of channel) {
    if (!inWin(m.at) || m.kind !== "report") continue;
    const x = /^(?:partial|blocked): [\s\S]*? Couldn't: ([\s\S]*?)(?: Needs: [\s\S]*)?$/.exec(m.text);
    if (!x) continue;
    const text = cut(x[1].trim(), 300);
    if (!couldnt.some((c) => c.text === text)) couldnt.push({ t: rel(m.at), from: roleLabel(m.from), text });
  }

  // ---- the headline numbers ----
  const dur = r1(tEnd - t0);
  const kept = assets.filter((a) => a.kept).length;
  const top = byRole[0];
  const stats: [string, string][] = [
    [usd(total), pitch.capUsd ? `spent of the ${usd(pitch.capUsd)} cap` : "spent"],
    [`${Math.round(dur / 60)} min`, "from the first message to the last task"],
    [String(calls.length), "model calls"],
    [String(kept), kept === 1 ? "asset of its own, kept" : "assets of its own, kept"],
  ];
  if (top && total > 0)
    stats.push([`${Math.round((top.usd / total) * 100)}%`, `of the money went to the ${top.label}`]);
  if (thinking) stats.push([`${thinking.share}%`, `of the ${thinking.label}'s tokens were thinking`]);

  const summary: Summary = {
    project: { id: pitch.id, title: pitch.title, idea: pitch.idea, capUsd: pitch.capUsd },
    window: {
      run: opts.run ?? null,
      runs: runs
        .filter((r) => inWin(r.from))
        .map((r) => ({ id: r.id, status: r.status, s: rel(r.from), e: r.to ? rel(r.to) : null })),
    },
    t0,
    date: new Date(t0 * 1000).toISOString().slice(0, 10),
    dur,
    total,
    ncalls: calls.length,
    stats,
    exported,
    outputs,
    assets,
    lanes,
    you,
    pipDots,
    revs,
    incidents,
    byRole,
    byProject,
    thinking,
    fail,
    couldnt,
    picks: opts.picks ? readPicks(opts.picks) : null,
    findings: opts.notes ? parseFindings(readFileSync(opts.notes, "utf8")) : null,
  };
  return { summary: redactDeep(summary, dir), images };
}
