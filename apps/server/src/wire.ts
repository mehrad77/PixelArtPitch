// Connects the crew (orchestrator, providers, ledger, settings) to the server and registers the crew tools.

import { type ExternalTools, Pip, translator } from "@pap/crew/assistant";
import { PipConductor } from "@pap/crew/conductor";
import { ModelGateway } from "@pap/crew/gateway-impl";
import {
  createProvider,
  type ModelInfo,
  modelsFor,
  publicSettings,
  ROLES,
  rolesForProfile,
  saveSettings,
  withProbe,
} from "@pap/crew/llm/index";
import { Crew } from "@pap/crew/orchestrator";
import {
  crewRequestChangeTool,
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
}): Promise<{
  crew?: CrewApi;
  hooks?: Hooks;
  pip?: Pip;
  gateway: ModelGateway;
  crewImpl: Crew;
  connections: Connections;
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
    crewRequestChangeTool((p, note, extra) => crew.requestChange(p, note, extra)),
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
      else if (decision === "decline") crew.declineOverrun(p);
    },
  });

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

  const hooks: Hooks = {
    settings: {
      get: () => publicSettings(gateway.publicSettings(), gateway.secrets),
      put: (v: any) => {
        const cur = structuredClone(gateway.publicSettings());
        // connections change only through /api/connections
        const next = {
          ...cur,
          ...v,
          providers: v.providers ?? cur.providers,
          roles: v.roles ?? cur.roles,
          connections: cur.connections,
        };
        if (v.profile && v.profile !== cur.profile && !v.roles)
          next.roles =
            rolesForProfile(v.profile, { providers: next.providers, current: cur.roles as any }) ?? cur.roles;
        saveSettings(next);
        gateway.reload();
        return publicSettings(gateway.publicSettings(), gateway.secrets);
      },
      setKey: (id, key) => {
        const cfg = gateway.publicSettings().providers.find((p) => p.id === id);
        if (cfg) gateway.secrets.setKey(cfg.id, key);
        gateway.reload();
      },
      test: async (id) => {
        const cfg = gateway.publicSettings().providers.find((p) => p.id === id);
        if (!cfg) return { ok: false, error: `no provider ${id}` };
        try {
          const list = await createProvider({ ...cfg, enabled: true }, gateway.secrets).listModels(
            AbortSignal.timeout(8000),
          );
          return { ok: true, models: list.map((m) => m.id) };
        } catch (e: any) {
          return { ok: false, models: [], error: String(e?.message ?? e) };
        }
      },
      models: async () => {
        const list = await models();
        return list.map((m) => ({
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
        }));
      },
    },
    ledger: (q) => gateway.ledger.query({ project: q.project } as any).slice(-(q.limit ?? 200)),
  };
  return { crew, hooks, pip, gateway, crewImpl: crew, connections };
}
