// Every model call, in SQLite (node:sqlite) at <appData>/ledger.sqlite: cost, tokens, speed, the budget ticket.
// Also holds open budget reservations, so a restart can tell settled calls from in-flight ones.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appDataDir } from "./paths.ts";
import type { ChatResult, LedgerRow } from "./types.ts";

export type LedgerQuery = {
  project?: string;
  role?: string;
  /** full "<provider>/<model>" id */
  model?: string;
  taskKind?: string;
  /** ISO timestamp, inclusive */
  since?: string;
  limit?: number;
};

export type Speed = { ttftMs: number; tokPerSec: number; samples: number };

export const ledgerPath = (): string => join(appDataDir(), "ledger.sqlite");

/** Output tokens (thinking included) over the time after the first token. */
export function tokPerSec(outputTokens: number, durationMs: number, ttftMs: number): number {
  const s = Math.max(0.001, (durationMs - ttftMs) / 1000);
  return outputTokens / s;
}

export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}
export function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export type NewLedgerRow = Omit<LedgerRow, "id" | "ts" | "tokPerSec"> & { ts?: string; tokPerSec?: number };

/** A row from a ChatResult plus who/what it was for. `model` is the full "<provider>/<model>" id. */
export function rowFromResult(
  r: ChatResult,
  ctx: Omit<NewLedgerRow, "usage" | "usd" | "usdSource" | "ttftMs" | "durationMs" | "stop" | "estUsd"> & {
    estUsd?: number | null;
  },
): NewLedgerRow {
  return {
    ...ctx,
    estUsd: ctx.estUsd ?? null,
    usage: r.usage,
    usd: r.usd,
    usdSource: r.usdSource,
    ttftMs: r.ttftMs,
    durationMs: r.durationMs,
    tokPerSec: tokPerSec(r.usage.outputTokens, r.durationMs, r.ttftMs),
    stop: r.stop,
  };
}

const MICRO = 1e6;

export class Ledger {
  readonly db: DatabaseSync;
  constructor(path: string = ledgerPath()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, project TEXT NOT NULL, task TEXT NOT NULL, task_kind TEXT NOT NULL, role TEXT NOT NULL,
        attempt INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_1h_tokens INTEGER, thinking_tokens INTEGER,
        usd REAL NOT NULL, usd_source TEXT NOT NULL, ttft_ms REAL NOT NULL, duration_ms REAL NOT NULL,
        tok_per_sec REAL NOT NULL, stop TEXT NOT NULL, est_usd REAL, ticket TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_project ON calls(project, ts);
      CREATE INDEX IF NOT EXISTS calls_model ON calls(model, ts);
      CREATE INDEX IF NOT EXISTS calls_ticket ON calls(ticket);
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, usd_micro INTEGER NOT NULL, ts TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insert(row: NewLedgerRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO calls (ts, project, task, task_kind, role, attempt, provider, model, prompt_version, input_tokens,
          output_tokens, cache_write_tokens, cache_read_tokens, cache_write_1h_tokens, thinking_tokens, usd, usd_source,
          ttft_ms, duration_ms, tok_per_sec, stop, est_usd, ticket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts ?? new Date().toISOString(),
        row.project,
        row.task,
        row.taskKind,
        row.role,
        row.attempt,
        row.provider,
        row.model,
        row.promptVersion,
        row.usage.inputTokens,
        row.usage.outputTokens,
        row.usage.cacheWriteTokens ?? null,
        row.usage.cacheReadTokens ?? null,
        row.usage.cacheWrite1hTokens ?? null,
        row.usage.thinkingTokens ?? null,
        row.usd,
        row.usdSource,
        row.ttftMs,
        row.durationMs,
        row.tokPerSec ?? tokPerSec(row.usage.outputTokens, row.durationMs, row.ttftMs),
        row.stop,
        row.estUsd,
        row.ticket ?? null,
      );
    return Number(r.lastInsertRowid);
  }

  private where(q: LedgerQuery): { sql: string; args: (string | number)[] } {
    const c: string[] = [];
    const args: (string | number)[] = [];
    if (q.project !== undefined) c.push("project = ?") && args.push(q.project);
    if (q.role !== undefined) c.push("role = ?") && args.push(q.role);
    if (q.model !== undefined) c.push("model = ?") && args.push(q.model);
    if (q.taskKind !== undefined) c.push("task_kind = ?") && args.push(q.taskKind);
    if (q.since !== undefined) c.push("ts >= ?") && args.push(q.since);
    return { sql: c.length ? `WHERE ${c.join(" AND ")}` : "", args };
  }

  query(q: LedgerQuery = {}): LedgerRow[] {
    const w = this.where(q);
    const rows = this.db
      .prepare(`SELECT * FROM calls ${w.sql} ORDER BY id DESC LIMIT ?`)
      .all(...w.args, q.limit ?? 1000) as any[];
    return rows.map(toRow);
  }

  totalUsd(q: LedgerQuery = {}): number {
    const w = this.where(q);
    const r = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS s FROM calls ${w.sql}`).get(...w.args) as { s: number };
    return r.s;
  }

  /** Rolling speed for a model over its last `window` completed calls. */
  speed(model: string, window = 50): Speed | null {
    const rows = this.db
      .prepare(
        `SELECT ttft_ms, tok_per_sec FROM calls WHERE model = ? AND stop IN ('end', 'tool_use', 'max_tokens')
         AND output_tokens > 0 ORDER BY id DESC LIMIT ?`,
      )
      .all(model, window) as { ttft_ms: number; tok_per_sec: number }[];
    if (!rows.length) return null;
    return {
      ttftMs: median(rows.map((r) => r.ttft_ms)),
      tokPerSec: median(rows.map((r) => r.tok_per_sec)),
      samples: rows.length,
    };
  }

  speeds(window = 50): Record<string, Speed> {
    const models = this.db.prepare("SELECT DISTINCT model FROM calls").all() as { model: string }[];
    const out: Record<string, Speed> = {};
    for (const { model } of models) {
      const s = this.speed(model, window);
      if (s) out[model] = s;
    }
    return out;
  }

  /** Observed per-call cost and output tokens for a task kind (optionally one model). */
  kindStats(taskKind: string, model?: string, window = 200) {
    const rows = this.db
      .prepare(
        `SELECT usd, output_tokens FROM calls WHERE task_kind = ? ${model ? "AND model = ?" : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...(model ? [taskKind, model, window] : [taskKind, window])) as { usd: number; output_tokens: number }[];
    const usd = rows.map((r) => r.usd);
    const out = rows.map((r) => r.output_tokens);
    return {
      n: rows.length,
      usd: { p50: quantile(usd, 0.5), p90: quantile(usd, 0.9) },
      out: { p50: quantile(out, 0.5), p90: quantile(out, 0.9) },
    };
  }

  // ---- reservations (BudgetGuard) ----
  addReservation(id: string, project: string, usd: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO reservations (id, project, usd_micro, ts) VALUES (?, ?, ?, ?)")
      .run(id, project, Math.round(usd * MICRO), new Date().toISOString());
  }
  removeReservation(id: string): void {
    this.db.prepare("DELETE FROM reservations WHERE id = ?").run(id);
  }
  openReservations(project: string): { id: string; usdMicro: number; ts: string; settled: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.usd_micro, r.ts, EXISTS (SELECT 1 FROM calls c WHERE c.ticket = r.id) AS settled
         FROM reservations r WHERE r.project = ?`,
      )
      .all(project) as { id: string; usd_micro: number; ts: string; settled: number }[];
    return rows.map((r) => ({ id: r.id, usdMicro: r.usd_micro, ts: r.ts, settled: !!r.settled }));
  }
}

function toRow(r: any): LedgerRow {
  const opt = (x: unknown) => (x === null || x === undefined ? undefined : Number(x));
  return {
    id: Number(r.id),
    ts: r.ts,
    project: r.project,
    task: r.task,
    taskKind: r.task_kind,
    role: r.role,
    attempt: Number(r.attempt),
    provider: r.provider,
    model: r.model,
    promptVersion: r.prompt_version,
    usage: {
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheWriteTokens: opt(r.cache_write_tokens),
      cacheReadTokens: opt(r.cache_read_tokens),
      cacheWrite1hTokens: opt(r.cache_write_1h_tokens),
      thinkingTokens: opt(r.thinking_tokens),
    },
    usd: r.usd,
    usdSource: r.usd_source,
    ttftMs: r.ttft_ms,
    durationMs: r.duration_ms,
    tokPerSec: r.tok_per_sec,
    stop: r.stop,
    estUsd: r.est_usd,
    ticket: r.ticket,
  };
}

// ---- priors (seeded from the proof of concept's log, checked in as aggregates) ----
export type Quant = { p50: number; p90: number };
export type Prior = {
  n: number;
  effort: string;
  tokens: { in: Quant; cacheWrite: Quant; cacheWrite1h: Quant; cacheRead: Quant; out: Quant; thinking: Quant };
  usd: Quant;
  /** output ~ (cells / refCells) ^ exponent */
  size?: { refCells: number; exponent: number; n: number };
};
export type Priors = { source: { model: string; calls: number }; kinds: Record<string, Prior> };

let priorsCache: Priors | null = null;
export function loadPriors(): Priors {
  priorsCache ??= JSON.parse(readFileSync(new URL("./priors.json", import.meta.url), "utf8")) as Priors;
  return priorsCache;
}
export const priorFor = (taskKind: string): Prior | null => loadPriors().kinds[taskKind] ?? null;
