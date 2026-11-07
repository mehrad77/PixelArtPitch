// Per-project spend control. Every call reserves its worst case first; admission is atomic (synchronous check and
// reserve, integer micro-dollars), so concurrent callers can never overshoot `cap - floor`.
// Reservations live in the ledger's SQLite file: after a crash, an open reservation counts as spent until a ledger row
// carrying its ticket shows what the call really cost.
import { randomUUID } from "node:crypto";
import type { Ledger } from "./ledger.ts";
import { rowFromResult } from "./ledger.ts";
import { isLocalProvider } from "./openai.ts";
import { worstCaseUsd } from "./prices.ts";
import {
  BudgetError,
  type ChatRequest,
  type ChatResult,
  type Price,
  type Provider,
  type StreamEvent,
} from "./types.ts";

const MICRO = 1_000_000;
const toMicro = (usd: number) => Math.max(0, Math.ceil(usd * MICRO - 1e-6));

export type Ticket = { id: string; needUsd: number; readonly micro: number };

export type BudgetOpts = {
  project: string;
  capUsd: number;
  /** kept free, never admitted (the project's `budget.reserveUsd`) */
  floorUsd?: number;
  /** fraction of the cap at which to ask the user (default 0.8) */
  askAtFraction?: number;
  /** called once each time committed spend (spent + reserved) crosses askAtFraction */
  onThreshold?: (fraction: number) => void;
  /** persist reservations and recover spend after restarts */
  ledger?: Ledger;
};

export class BudgetGuard {
  readonly project: string;
  private capMicro: number;
  private floorMicro: number;
  private askAt: number;
  private onThreshold?: (fraction: number) => void;
  private ledger?: Ledger;
  private spentMicro = 0;
  private reservedMicro = 0;
  private open = new Map<string, Ticket>();
  private asked = false;

  constructor(opts: BudgetOpts) {
    this.project = opts.project;
    this.capMicro = toMicro(opts.capUsd);
    this.floorMicro = toMicro(opts.floorUsd ?? 0);
    this.askAt = opts.askAtFraction ?? 0.8;
    this.onThreshold = opts.onThreshold;
    this.ledger = opts.ledger;
    this.reconcile();
  }

  /** Spent = ledger rows for the project, plus reservations no ledger row has settled (they may have been billed). */
  reconcile(): void {
    if (!this.ledger) return;
    let spent = toMicro(this.ledger.totalUsd({ project: this.project }));
    for (const r of this.ledger.openReservations(this.project)) {
      if (this.open.has(r.id)) continue;
      if (r.settled) this.ledger.removeReservation(r.id);
      else spent += r.usdMicro;
    }
    this.spentMicro = spent;
  }

  /** Drop orphaned reservations from a previous run once you know they were never billed (e.g. after a console check). */
  forgetOrphans(): void {
    if (!this.ledger) return;
    for (const r of this.ledger.openReservations(this.project)) {
      if (!this.open.has(r.id) && !r.settled) this.ledger.removeReservation(r.id);
    }
    this.reconcile();
  }

  get capUsd() {
    return this.capMicro / MICRO;
  }
  get spentUsd() {
    return this.spentMicro / MICRO;
  }
  get reservedUsd() {
    return this.reservedMicro / MICRO;
  }
  /** what a new reservation can still take */
  get availableUsd() {
    return Math.max(0, this.capMicro - this.floorMicro - this.spentMicro - this.reservedMicro) / MICRO;
  }

  setCap(capUsd: number): void {
    this.capMicro = toMicro(capUsd);
    this.asked = this.committedFraction() >= this.askAt;
  }

  private committedFraction() {
    return this.capMicro ? (this.spentMicro + this.reservedMicro) / this.capMicro : 1;
  }
  private checkThreshold() {
    const f = this.committedFraction();
    if (!this.asked && f >= this.askAt) {
      this.asked = true;
      this.onThreshold?.(f);
    }
  }

  /** Admit a call whose worst case is `needUsd`, or throw BudgetError. Synchronous: no await between check and hold. */
  reserve(needUsd: number): Ticket {
    const micro = toMicro(Math.max(0, needUsd));
    if (this.spentMicro + this.reservedMicro + micro > this.capMicro - this.floorMicro) {
      throw new BudgetError((this.spentMicro + this.reservedMicro) / MICRO, this.capMicro / MICRO, needUsd);
    }
    const t: Ticket = { id: randomUUID(), needUsd, micro };
    this.reservedMicro += micro;
    this.open.set(t.id, t);
    this.ledger?.addReservation(t.id, this.project, micro / MICRO);
    this.checkThreshold();
    return t;
  }

  /** The call finished: its actual cost replaces the reservation. Write the ledger row (with `ticket`) first. */
  settle(ticket: Ticket, actualUsd: number): void {
    if (!this.open.delete(ticket.id)) return;
    this.reservedMicro -= ticket.micro;
    this.spentMicro += toMicro(Math.max(0, actualUsd));
    this.ledger?.removeReservation(ticket.id);
    this.checkThreshold();
  }

  /** The call never ran (or was aborted before billing): free the reservation. */
  release(ticket: Ticket): void {
    if (!this.open.delete(ticket.id)) return;
    this.reservedMicro -= ticket.micro;
    this.ledger?.removeReservation(ticket.id);
  }

  /** reserve, run, settle with what `fn` reports, release on throw */
  async run<T>(needUsd: number, fn: (ticket: Ticket) => Promise<{ value: T; usd: number }>): Promise<T> {
    const t = this.reserve(needUsd);
    try {
      const { value, usd } = await fn(t);
      this.settle(t, usd);
      return value;
    } finally {
      this.release(t);
    }
  }
}

/** Rough input size: ~3.5 characters per token for text, a flat 1,600 per image (a ceiling for small images). */
export function estimateInputTokens(req: ChatRequest): number {
  let chars = (req.system ?? "").length;
  let images = 0;
  const add = (c: unknown) => {
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === "image") images++;
        else if (p.type === "text") chars += p.text.length;
        else if (p.type === "tool_call") chars += JSON.stringify(p.input ?? {}).length + p.name.length;
        else if (p.type === "opaque") chars += JSON.stringify(p.block ?? "").length;
      }
    }
  };
  for (const m of req.messages) add(m.content);
  for (const t of req.tools ?? []) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  if (req.json) chars += JSON.stringify(req.json.schema).length;
  return Math.ceil(chars / 3.5) + images * 1600 + 50;
}

export type MeterCtx = {
  guard: BudgetGuard;
  ledger?: Ledger;
  /**
   * Price for the worst case: return the model's `ModelInfo.price` first (OpenRouter reports its own), then
   * `priceFor(modelId)` (table and manual overrides). null is only accepted for free models.
   */
  price: (modelId: string) => Price | null;
  /** whether a model with no price may run; default: the provider is a local server (LM Studio, Ollama, llama.cpp) */
  free?: (modelId: string) => boolean;
  task: string;
  taskKind: string;
  role: Parameters<typeof rowFromResult>[1]["role"];
  attempt?: number;
  promptVersion?: string;
  estUsd?: number | null;
};

/**
 * Wrap a provider so every chat reserves its worst case, writes a ledger row and settles; aborted or failed calls
 * release their reservation. Compose it under chatJson to meter each ladder rung separately.
 */
export function metered(provider: Provider, ctx: MeterCtx): Provider {
  const free = ctx.free ?? (() => isLocalProvider(provider.config));
  return {
    config: provider.config,
    listModels: (signal) => provider.listModels(signal),
    async chat(req: ChatRequest, opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void }) {
      const price = ctx.price(req.model);
      if (!price && !free(req.model)) {
        throw new Error(`${req.model}: no price known; set a manual price before spending on it`);
      }
      const estIn = estimateInputTokens(req);
      const need = worstCaseUsd(price, estIn, req.maxOut, req.cache);
      const ticket = ctx.guard.reserve(need);
      let result: ChatResult;
      try {
        result = await provider.chat(req, opts);
      } catch (e) {
        ctx.guard.release(ticket);
        throw e;
      }
      const slash = req.model.indexOf("/");
      ctx.ledger?.insert({
        ...rowFromResult(result, {
          project: ctx.guard.project,
          task: ctx.task,
          taskKind: ctx.taskKind,
          role: ctx.role,
          attempt: ctx.attempt ?? 0,
          provider: slash > 0 ? req.model.slice(0, slash) : provider.config.id,
          model: req.model,
          promptVersion: ctx.promptVersion ?? "",
          estUsd: ctx.estUsd ?? null,
          ticket: ticket.id,
          effort: req.effort ?? null,
        }),
        estInTokens: estIn,
      });
      ctx.guard.settle(ticket, result.usd);
      return result;
    },
  };
}
