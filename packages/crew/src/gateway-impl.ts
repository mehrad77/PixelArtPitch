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

export class ModelGateway implements Gateway {
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
      const res = await chatJson(
        prov,
        { model, system: spec.system, messages: spec.messages, maxOut: spec.maxOut, effort: spec.effort, cache: true },
        spec.schema,
        {
          caps: this.caps(model) ?? undefined,
          signal: spec.signal,
          onEvent: spec.onEvent,
          normalize: spec.normalize as any,
        },
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
