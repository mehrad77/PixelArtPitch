// Connects the crew (orchestrator, providers, ledger, settings) to the server and registers the crew tools.

import { type ExternalTools, Pip, translator } from "@pap/crew/assistant";
import { DraftConversations } from "@pap/crew/brief/drafts";
import { PipConductor } from "@pap/crew/conductor";
import { ModelGateway } from "@pap/crew/gateway-impl";
import {
  createProvider,
  type ModelInfo,
  mergeSettings,
  modelsFor,
  probeModel,
  publicSettings,
  ROLES,
  rolesForProfile,
  saveSettings,
  withProbe,
} from "@pap/crew/llm/index";
import { Crew } from "@pap/crew/orchestrator";
import { routeChange } from "@pap/crew/plan/route";
import { setUserLibrary } from "@pap/render";
import {
  crewRequestChangeTool,
  DraftStore,
  defineTool,
  fail,
  ok,
  type Registry,
  subtitlesTranslateTool,
  type Workspace,
} from "@pap/tools";
import { z } from "zod";
import type { CrewApi, Hooks } from "./app.ts";
import { Connections } from "./connections.ts";

export async function wireCrew(deps: {
  workspace: Workspace;
  registry: Registry;
  /** tests and scripts: a gateway over fake or chosen providers */
  gateway?: ModelGateway;
  external?: ExternalTools;
  /** false: don't resume interrupted crews (scripts) */
  resume?: boolean;
  /** where drafts live (default $PAP_HOME/drafts) */
  drafts?: DraftStore;
}): Promise<{
  crew?: CrewApi;
  hooks?: Hooks;
  pip?: Pip;
  gateway: ModelGateway;
  crewImpl: Crew;
  connections: Connections;
  drafts: DraftConversations;
}> {
  const gateway = deps.gateway ?? new ModelGateway();
  // the person's MCP servers: saved in settings (secrets in the SecretStore), never in the registry
  const connections = new Connections({
    load: () => structuredClone(gateway.publicSettings().connections ?? []),
    save: (list) => {
      const s = gateway.publicSettings();
      s.connections = list;
      if (!deps.gateway) saveSettings(s);
    },
    secrets: gateway.secrets,
  });
  // publish writes to the person's library (settings.paths.library); the repo's library/ is the read-only seed
  setUserLibrary(gateway.publicSettings().paths?.library);
  const crew = new Crew({ workspace: deps.workspace, registry: deps.registry, gateway });
  // a crash or restart never loses a crew: pick up every run that was in progress
  if (deps.resume !== false)
    setTimeout(() => {
      const resumed = crew.resumeInterrupted();
      if (resumed.length) console.log(`resumed the crew on: ${resumed.join(", ")}`);
    }, 500).unref();
  gateway.onThreshold = (project, f) => {
    try {
      deps.workspace
        .get(project)
        .emit("log", { level: "warn", text: `budget: ${Math.round(f * 100)}% of the cap is spent or reserved` });
    } catch {}
  };

  deps.registry.add(
    defineTool({
      name: "crew_run",
      title: "Start the crew",
      description:
        "Start (or continue) the crew on a project from its current stage. Returns at once; follow crew_status.",
      input: z.object({ stage: z.string().optional() }),
      output: z.object({ started: z.boolean() }),
      roles: [],
      tier: "basic",
      effects: "spend",
      project: true,
      handler: async (i, ctx) => {
        const p = ctx.project!;
        crew.run(p, { stage: i.stage }).catch((e) => p.emit("log", { level: "error", text: String(e?.message ?? e) }));
        return ok({ started: true });
      },
    }),
    defineTool({
      name: "crew_retry",
      title: "Redo what failed",
      description:
        "Lift a held crew run (after a key or provider fix), or run a project's failed and fallback steps again, with the work after them. Pass taskId for one step. Returns at once; follow crew_status.",
      input: z.object({ taskId: z.string().max(80).optional() }),
      output: z.object({ started: z.boolean(), resumed: z.boolean() }),
      roles: [],
      tier: "basic",
      effects: "spend",
      project: true,
      handler: async (i, ctx) => {
        const r = crew.retry(ctx.project!, { taskId: i.taskId });
        if (r.busy)
          return fail("busy", "the crew is working on this project", {
            fix: "wait for the run to end, or pause it first",
          });
        return ok({ started: r.started, resumed: r.resumed });
      },
    }),
    defineTool({
      name: "crew_status",
      title: "Crew status",
      description: "Stage, gates, tasks, open questions, budget and ETA of a project's crew.",
      input: z.object({}),
      output: z.unknown(),
      roles: "*",
      tier: "basic",
      effects: "read",
      project: true,
      handler: async (_i, ctx) => {
        const p = ctx.project!;
        return ok({
          stage: p.state.stage,
          digest: p.state.digest,
          paused: p.state.paused,
          gates: p.state.gates.map((g) => ({ id: g.id, status: g.status })),
          tasks: p.state.tasks.slice(-20).map((t) => ({
            id: t.id,
            role: t.role,
            title: t.title,
            status: t.status,
            usd: +t.usd.toFixed(4),
            model: t.model,
            error: t.error,
          })),
          questions: p.state.questions.filter((q) => q.status === "open"),
          ...crew.status(p),
        });
      },
    }),
    defineTool({
      name: "crew_pause",
      title: "Pause the crew",
      description: "Pause after the current step (default) or now.",
      input: z.object({ mode: z.enum(["after_step", "now"]).default("after_step") }),
      output: z.object({ paused: z.boolean() }),
      roles: [],
      tier: "basic",
      effects: "write",
      project: true,
      handler: async (i, ctx) => {
        crew.pause(ctx.project!, i.mode);
        return ok({ paused: true });
      },
    }),
    defineTool({
      name: "gate_decide",
      title: "Pass or reject a gate",
      description: "Approve a gate (brief, script, animatic, rough cut, final) or ask for changes with reasons.",
      input: z.object({
        gate: z.enum(["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"]),
        verdict: z.enum(["approve", "approve_notes", "changes"]),
        reasons: z.array(z.string().max(300)).max(10).default([]),
      }),
      output: z.unknown(),
      roles: [],
      tier: "basic",
      effects: "write",
      project: true,
      handler: async (i, ctx) => {
        const p = ctx.project!;
        if (!p.state.gates.some((g) => g.id === i.gate)) return fail("not_found", `no gate ${i.gate}`);
        return ok(
          crew.gate(p, i.gate, { verdict: i.verdict, reasons: i.reasons, by: ctx.author.client ?? ctx.author.kind }),
        );
      },
    }),
  );

  // Pip's tools come after the crew tools: one needs the Writer's model, the other the orchestrator
  deps.registry.add(
    subtitlesTranslateTool(translator(gateway)),
    crewRequestChangeTool(
      (p, note, extra) => crew.requestChange(p, note, extra),
      (n) => routeChange(n),
    ),
  );
  const pip = new Pip({
    workspace: deps.workspace,
    registry: deps.registry,
    gateway,
    crewRunning: (p) => crew.status(p).crew.running,
    crewStatus: (p) => crew.status(p),
    instanceAbout: (p, id) => crew.instanceAbout(p, id),
    external: deps.external ?? connections,
    lend: (p, role, tools) => crew.lend(p, role, tools),
    resolveLend: (ref) => connections.resolve(ref)?.name,
    crewDecide: (p, what, decision) => {
      if (what === "pending") decision === "confirm" ? crew.confirmPending(p) : crew.declinePending(p);
      else if (what === "finish" && decision === "confirm") crew.finishWithinBudget(p);
      else if (decision === "decline") crew.declineOverrun(p);
    },
    crewSnapshot: (p) => crew.snapshot(p),
    changeCost: (p, c) => crew.changeCost(p, c),
    // a project the plan never ran keeps the card's own faces
    changePreview: (p, b) => (crew.planNow(p) ? crew.previewChange(p, b) : null),
  });
  // a held run (a rejected key, no credit, no connection): Pip says so once in the thread
  crew.onHold = (p, h) => {
    pip.holdNotice(p, h);
  };

  // Pip directs the crew on its triggers (asks, partial/blocked reports, blockers, stage checks)
  const conductor = new PipConductor({ gateway, modeFor: (m) => pip.modeFor(m) });
  crew.conductor = conductor;
  // the production plan (docs/PIP-ORCHESTRATION.md): Pip's revision runs in agent mode only; its cards come from Pip
  crew.pipModeFor = (m) => pip.modeFor(m);
  conductor.plan = (p) =>
    (crew.planNow(p)?.tasks ?? [])
      .filter((t) => ["pending", "ready", "running", "waiting_person"].includes(t.status))
      .map((t) => `${t.id} (${t.kind}${t.scene ? ` ${t.scene}` : ""}${t.asset ? ` ${t.asset}` : ""})`)
      .join(", ");
  crew.onPlanCard = (p, c) => pip.revisionCard(p, c);
  crew.onOverrun = (p, o) => {
    pip.overrunCard(p, o);
  };
  // at `auto` the crew finished within the cap by itself: Pip says what went
  crew.onFinish = (p, o) => {
    pip.finishNotice(p, o);
  };
  deps.registry.add(
    defineTool({
      name: "ask_pip",
      title: "Ask Pip",
      description:
        "A crew member's question goes to Pip, who answers from the brief and the person's decisions, or asks the person when only they know (names, claims, rights, taste, budget). Give 2-6 options and a recommended one.",
      input: z.object({
        question: z.string().min(5).max(200),
        options: z
          .array(z.object({ id: z.string().regex(/^[a-z0-9_-]+$/), label: z.string().min(1).max(80) }))
          .min(2)
          .max(6),
        recommendedId: z.string(),
      }),
      output: z.object({ answer: z.string().nullable(), askedPerson: z.boolean() }),
      roles: "*",
      tier: "basic",
      effects: "read",
      project: true,
      handler: async (i, ctx) => {
        const role = (ctx.author.role ?? "producer") as any;
        const a = await crew.askPipNow(ctx.project!, role, i);
        if (a) return ok({ answer: a, askedPerson: false });
        const q = ctx.project!.ask({ ...i, kind: "single", from: role }, role);
        const ans = await ctx.project!.waitAnswer(q.id, ctx.signal);
        return ok({ answer: ans.answer?.optionId ?? null, askedPerson: true });
      },
    }),
  );
  // a crew run's end settles the Pip cards that handed it work; cards a dead process left running settle on start
  crew.onRunEnd = (p, report) => pip.settle(p, report);
  setTimeout(() => {
    try {
      pip.settleStale((p) => crew.status(p).crew.running);
    } catch {}
  }, 1500).unref();

  // /new as a conversation (docs/PIP-ORCHESTRATION.md §3): drafts in $PAP_HOME/drafts, their turns on /api/events
  const isLocalKind = (k: string) => ["lmstudio", "ollama", "llamacpp"].includes(k);
  const drafts = new DraftConversations({
    store: deps.drafts ?? new DraftStore(),
    workspace: deps.workspace,
    gateway,
    pick: () => pip.pick(undefined),
    budget: () => pip.workspaceBudget(),
    emit: (draft, data) => pip.emitDraft(draft, data),
    localOn: () => gateway.publicSettings().providers.some((p) => p.enabled && isLocalKind(p.kind)),
    profile: () => gateway.publicSettings().profile,
    modelsFor: async (profile) => {
      const s = gateway.publicSettings();
      const r = rolesForProfile(profile, {
        providers: s.providers,
        models: profile === "local" ? await models() : [],
      });
      return r ? Object.fromEntries(Object.entries(r).map(([role, v]) => [role, v.model])) : null;
    },
    run: (p) => {
      crew.run(p).catch((e) => p.emit("log", { level: "error", text: String(e?.message ?? e) }));
    },
  });
  deps.registry.add(
    defineTool({
      name: "draft_create",
      title: "Make another like this",
      description:
        "Open a new draft on New video that keeps a project's audience, length, narration, involvement, profile, style and budget (never its idea or files). The person says the new idea there; nothing is made until they press Start.",
      input: z.object({ from: z.string().min(1).max(80) }),
      output: z.object({ draftId: z.string() }),
      roles: [],
      tier: "basic",
      effects: "write",
      project: false,
      examples: [{ input: { from: "questday" } }],
      handler: async (i) => {
        try {
          return ok({ draftId: drafts.create(i.from).draft.id });
        } catch (e: any) {
          return fail(e?.code ?? "not_found", String(e?.message ?? e), {
            fix: e?.fix ?? "use an id from project_list",
          });
        }
      },
    }),
  );

  const models = async (): Promise<ModelInfo[]> => {
    const s = gateway.publicSettings();
    const out: ModelInfo[] = [];
    for (const cfg of s.providers.filter((p) => p.enabled)) {
      try {
        out.push(
          ...(await createProvider(cfg, gateway.secrets).listModels(AbortSignal.timeout(5000))).map((m) =>
            withProbe(m),
          ),
        );
      } catch {}
    }
    return out;
  };

  /** a model as GET /api/models lists it */
  const row = (m: ModelInfo) => ({
    id: m.id,
    provider: m.provider,
    label: m.label,
    local: m.caps.local,
    caps: {
      vision: m.caps.vision,
      structured: m.caps.structured,
      tools: m.caps.tools,
      longOutput: m.caps.longOutput,
    },
    ctx: m.caps.ctx,
    maxOut: m.caps.maxOut,
    price: m.price,
    speed: gateway.ledger.speed(m.id) ?? null,
    spend30dUsd: gateway.ledger.totalUsd({
      model: m.id,
      since: new Date(Date.now() - 30 * 864e5).toISOString(),
    } as any),
    fit: Object.fromEntries(ROLES.map((r) => [r, modelsFor(r, [m]).shown.length ? 1 : 0])),
  });
  /**
   * GET /api/settings (N20): every role names the model it really runs on, Pip's included. A role left unset gets the
   * gateway's default; `effective` says which is which, and the fallback the gateway would use (Pip: the Producer's).
   */
  const settingsView = () => {
    const pub = publicSettings(gateway.publicSettings(), gateway.secrets);
    const saved = gateway.publicSettings().roles ?? {};
    const roles: Record<string, { model: string; fallback?: string }> = {};
    const effective: Record<
      string,
      {
        model: string;
        fallback: string | null;
        source: "saved" | "default";
        fallbackSource: "saved" | "producer" | "none";
      }
    > = {};
    for (const r of ROLES) {
      const own = saved[r];
      roles[r] = own?.model ? own : { model: gateway.modelFor(r) };
      const fb = gateway.fallbackFor(r) ?? null;
      effective[r] = {
        model: gateway.modelFor(r),
        fallback: fb,
        source: own?.model ? "saved" : "default",
        fallbackSource: own?.fallback ? "saved" : fb ? "producer" : "none",
      };
    }
    return { ...pub, roles: { ...pub.roles, ...roles }, effective };
  };

  const hooks: Hooks = {
    settings: {
      get: settingsView,
      put: (v: any) => {
        const cur = structuredClone(gateway.publicSettings());
        // connections change only through /api/connections
        // defaults and paths merge field by field: a form that sends four defaults keeps the rest (§ Settings)
        const next = {
          ...mergeSettings(cur, v ?? {}),
          providers: v.providers ?? cur.providers,
          roles: v.roles ?? cur.roles,
          connections: cur.connections,
        };
        if (v.profile && v.profile !== cur.profile && !v.roles)
          next.roles =
            rolesForProfile(v.profile, { providers: next.providers, current: cur.roles as any }) ?? cur.roles;
        saveSettings(next);
        gateway.reload();
        setUserLibrary(next.paths?.library);
        return settingsView();
      },
      // N22: what each profile assigns, from the server's own rule (rolesForProfile), so the UI never guesses
      profiles: async () => {
        const s = gateway.publicSettings();
        const local = s.providers.some((p) => p.enabled && isLocalKind(p.kind)) ? await models() : [];
        return {
          best: rolesForProfile("best", { providers: s.providers }),
          balanced: rolesForProfile("balanced", { providers: s.providers }),
          local: rolesForProfile("local", { providers: s.providers, models: local }),
          custom: s.profile === "custom" ? s.roles : null,
        };
      },
      // N21: probe one model's skills now (spends a few cents on a paid model; only on the person's request)
      probe: async (id) => {
        const s = gateway.publicSettings();
        const cfg = s.providers.find((p) => p.enabled && id.startsWith(`${p.id}/`));
        if (!cfg) return null;
        const prov = createProvider(cfg, gateway.secrets);
        const list = await prov.listModels(AbortSignal.timeout(8000)).catch(() => []);
        const m = list.find((x) => x.id === id);
        if (!m) return null;
        await probeModel(prov, m, { force: true, signal: AbortSignal.timeout(120_000) });
        return row(withProbe(m));
      },
      setKey: (id, key) => {
        const cfg = gateway.publicSettings().providers.find((p) => p.id === id);
        if (cfg) gateway.secrets.setKey(cfg.id, key);
        gateway.reload();
        // a new key lifts the runs held on this provider (§1.8)
        if (cfg && key) crew.providerFixed(cfg.id);
      },
      test: async (id) => {
        const cfg = gateway.publicSettings().providers.find((p) => p.id === id);
        if (!cfg) return { ok: false, error: `no provider ${id}` };
        try {
          const list = await createProvider({ ...cfg, enabled: true }, gateway.secrets).listModels(
            AbortSignal.timeout(8000),
          );
          // the provider answers again: runs held on it go on (not a credit hold: listing models needs no credit)
          crew.providerFixed(cfg.id, { test: true });
          return { ok: true, models: list.map((m) => m.id) };
        } catch (e: any) {
          return { ok: false, models: [], error: String(e?.message ?? e) };
        }
      },
      models: async () => (await models()).map(row),
    },
    ledger: (q) => gateway.ledger.query({ project: q.project } as any).slice(-(q.limit ?? 200)),
  };
  return { crew, hooks, pip, gateway, crewImpl: crew, connections, drafts };
}
