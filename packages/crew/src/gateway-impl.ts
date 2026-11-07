// The Gateway over the plain-HTTP model layer: settings pick the model per role, every call is metered (reserve the
// worst case, ledger row, settle) under one BudgetGuard per project, and the structured-output ladder returns JSON.
import type { RoleT } from "@pap/schema";
import type { CallOut, CallSpec, Gateway } from "./gateway.ts";
import {
  BudgetError,
  BudgetGuard,
  type Caps,
  chatJson,
  createProvider,
  estimatePlan,
  Ledger,
  loadSettings,
  metered,
  type Provider,
  priceFor,
  readProbe,
  SecretStore,
  type Settings,
} from "./llm/index.ts";

const DEFAULT_CAPS: Caps = {
  vision: "claimed",
  structured: "claimed",
  tools: "claimed",
  longOutput: "claimed",
  thinking: "adaptive",
  caching: true,
  ctx: 200000,
  maxOut: 64000,
  concurrency: 4,
  local: false,
} as Caps;

/** at most n calls at once per endpoint; local model servers handle one request at a time */
class Lanes {
  private active = 0;
  private queue: (() => void)[] = [];
  private n: number;
  constructor(n: number) {
    this.n = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((res) => this.queue.push(res));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class ModelGateway implements Gateway {
  private lanes = new Map<string, Lanes>();
  private lane(providerId: string) {
    let l = this.lanes.get(providerId);
    if (!l) {
      const local = ["lmstudio", "ollama", "llamacpp"].includes(
        this.settings.providers.find((p) => p.id === providerId)?.kind ?? "",
      );
      l = new Lanes(local ? 1 : Math.max(1, this.settings.defaults?.concurrency ?? 4));
      this.lanes.set(providerId, l);
    }
    return l;
  }
  readonly ledger: Ledger;
  readonly secrets: SecretStore;
  private settings: Settings;
  private guards = new Map<string, BudgetGuard>();
  private providers = new Map<string, Provider>();
  onThreshold?: (project: string, fraction: number) => void;

  constructor(opts: { ledger?: Ledger; secrets?: SecretStore; settings?: Settings } = {}) {
    this.ledger = opts.ledger ?? new Ledger();
    this.secrets = opts.secrets ?? new SecretStore();
    this.settings = opts.settings ?? loadSettings();
  }
  reload() {
    this.settings = loadSettings();
    this.providers.clear();
  }

  private provider(id: string): Provider {
    const hit = this.providers.get(id);
    if (hit) return hit;
    const cfg = this.settings.providers.find((p) => p.id === id);
    if (!cfg)
      throw Object.assign(new Error(`no provider "${id}" in settings`), { fix: "add it in Settings → Providers" });
    if (!cfg.enabled)
      throw Object.assign(new Error(`provider "${id}" is turned off`), { fix: "turn it on in Settings → Providers" });
    const p = createProvider(cfg, this.secrets);
    this.providers.set(id, p);
    return p;
  }

  guard(project: string, capUsd: number) {
    let g = this.guards.get(project);
    if (!g) {
      g = new BudgetGuard({ project, capUsd, ledger: this.ledger, onThreshold: (f) => this.onThreshold?.(project, f) });
      this.guards.set(project, g);
    }
    return g;
  }

  modelFor(role: RoleT, projectModels?: Record<string, string>) {
    return projectModels?.[role] ?? this.settings.roles?.[role]?.model ?? "anthropic/claude-sonnet-5-5";
  }
  private fallbackFor(role: RoleT) {
    return this.settings.roles?.[role]?.fallback;
  }

  caps(model: string): Caps | null {
    const probe = readProbe(model);
    return (probe?.caps as Caps | undefined) ?? (model.startsWith("anthropic/") ? DEFAULT_CAPS : null);
  }

  async json<T>(spec: CallSpec<T>): Promise<CallOut<T>> {
    const tryModel = async (model: string): Promise<CallOut<T>> => {
      const providerId = model.slice(0, model.indexOf("/"));
      const guard = this.guard(spec.project, spec.capUsd);
      const prov = metered(this.provider(providerId), {
        guard,
        ledger: this.ledger,
        price: (m) => priceFor(m),
        task: spec.task,
        taskKind: spec.taskKind,
        role: spec.role,
        promptVersion: spec.promptVersion,
      });
      const res = await this.lane(providerId).run(() =>
        chatJson(
          prov,
          {
            model,
            system: spec.system,
            messages: spec.messages,
            // a local model that runs away should fail fast so the fallback takes over
            maxOut: providerId === "anthropic" ? spec.maxOut : Math.min(spec.maxOut, 6000),
            // local reasoning models can think through a whole output budget: keep them brief
            effort: providerId === "anthropic" ? spec.effort : "low",
            cache: true,
            // small local models loop at their default temperature
            ...(providerId === "anthropic" ? {} : { temperature: 0.4 }),
          },
          spec.schema,
          {
            caps: this.caps(model) ?? undefined,
            signal: spec.signal,
            onEvent: spec.onEvent,
            normalize: spec.normalize as any,
          },
        ),
      );
      return { data: res.json as T, result: res, model };
    };
    const model = spec.model ?? this.modelFor(spec.role);
    try {
      return await tryModel(model);
    } catch (e: any) {
      // escalate once to the role's fallback on a model failure (never on budget or a cancel)
      const fb = this.fallbackFor(spec.role);
      if (e instanceof BudgetError || spec.signal?.aborted || !fb || fb === model) throw e;
      return tryModel(fb);
    }
  }

  spent(project: string) {
    const g = this.guards.get(project);
    if (g) return { spentUsd: g.spentUsd, reservedUsd: g.reservedUsd };
    return { spentUsd: this.ledger.totalUsd({ project }), reservedUsd: 0 };
  }

  estimate(_project: string, tasks: { kind: string; role: RoleT; count?: number }[]) {
    if (!tasks.length) return { usd: [0, 0] as [number, number], sec: [0, 0] as [number, number] };
    try {
      const plan = tasks.flatMap((t) =>
        Array.from({ length: t.count ?? 1 }, () => {
          const id = this.modelFor(t.role);
          return { kind: t.kind, model: { id, price: priceFor(id) } };
        }),
      );
      const e = estimatePlan(plan, this.settings.defaults?.concurrency ?? 4, { ledger: this.ledger });
      return { usd: e.usd, sec: e.sec };
    } catch {
      return null;
    }
  }

  publicSettings() {
    return this.settings;
  }
}
