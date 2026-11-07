// Pip as the orchestrator (docs/ASSISTANT.md, "the crew channel"). The stage machine runs the routine work; on the
// five triggers the orchestrator calls think(), and Pip answers with crew_* decisions. On agent-capable models that is
// a short tool loop on Pip's own model (metered as assistant.conduct); on weak or local models it is fixed rules:
// answer from the defaults, redo once, then hold.
import type { OpenProject } from "@pap/tools";
import { z } from "zod";
import type { Gateway } from "./gateway.ts";
import type { ChatMessage, ToolSpec } from "./llm/types.ts";
import type { ChangePlan, Conductor, Decision, Trigger } from "./orchestrator.ts";
import { PlanDiffOut } from "./plan/schema.ts";
import { card, fill } from "./prompts.ts";

const ROLES = [
  "producer",
  "writer",
  "director",
  "art-director",
  "pixel-artist",
  "animator",
  "sound-designer",
  "mixer",
  "editor",
  "reviewer",
] as const;
const DecisionIn = {
  crew_brief: z.object({ role: z.enum(ROLES), text: z.string().min(3).max(400), ref: z.string().optional() }),
  crew_answer: z.object({ askId: z.string(), text: z.string().max(400).default(""), optionId: z.string().optional() }),
  crew_redo: z.object({ scenes: z.array(z.string()).min(1).max(8), why: z.string().min(3).max(400) }),
  crew_reboard: z.object({ scenes: z.array(z.string()).min(1).max(8), direction: z.string().min(3).max(400) }),
  crew_next: z.object({ why: z.string().max(300).optional() }),
  crew_hold: z.object({ why: z.string().min(3).max(300) }),
  crew_escalate: z.object({
    question: z.string().min(5).max(200),
    options: z.array(z.string().max(80)).max(6).optional(),
  }),
  crew_replan: PlanDiffOut,
};
const TOOLS: ToolSpec[] = Object.entries(DecisionIn).map(([name, schema]) => ({
  name,
  description: {
    crew_brief: "A direction for a member's next task.",
    crew_answer: "Answer a crew member's question (askId from the trigger).",
    crew_redo: "Redo these scenes, with a reason the Animator can act on.",
    crew_reboard: "The Director re-plans these scenes' recipes, with a direction.",
    crew_next: "On track: carry on.",
    crew_hold: "Stop and tell the person what's wrong.",
    crew_escalate: "Ask the person something only they know.",
    crew_replan:
      "Change the production plan: add a drawing (asset.spec), a logo import or a scene redo, drop or retier a pending task by its id. Code adds the chain and its gates; the validator may refuse it.",
  }[name]!,
  inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
}));
const TERMINAL = new Set([
  "crew_answer",
  "crew_redo",
  "crew_reboard",
  "crew_next",
  "crew_hold",
  "crew_escalate",
  "crew_replan",
]);

/** questions only the person can answer */
const PERSON_ONLY =
  /\b(name|names|called|claim|true|legal|rights?|licen[cs]e|likeness|logo|brand|budget|price|cost|deadline|date|url|website|email|phone|address|who is|which person|real)\b/i;

export function describe(t: Trigger): string {
  switch (t.kind) {
    case "ask":
      return `The ${t.from} asks (askId ${t.askId}): ${t.question}\nOptions: ${t.options.map((o) => `${o.id} = ${o.label}`).join("; ")} (recommended ${t.recommendedId})`;
    case "report":
      return `The ${t.from} reports ${t.report.status} on ${t.ref ?? t.task}: ${t.report.did}${t.report.couldnt ? ` Couldn't: ${t.report.couldnt}` : ""}${t.report.needs ? ` Needs: ${t.report.needs}` : ""}`;
    case "blocker":
      return `The Reviewer found blockers on scenes the person asked to change (review round ${t.round + 1}):\n- ${t.text.join("\n- ")}`;
    case "stage":
      return `The ${t.stage} stage ended, but these requests from the person are still open:\n- ${t.notes.join("\n- ")}`;
  }
}

/** the fixed rules: answer from the defaults, redo once, then hold */
export function rules(t: Trigger, ctx: { redos: Map<string, number> }): Decision[] {
  switch (t.kind) {
    case "ask":
      return PERSON_ONLY.test(t.question)
        ? [{ kind: "escalate", question: t.question, options: t.options.map((o) => o.label) }]
        : [
            {
              kind: "answer",
              askId: t.askId,
              optionId: t.recommendedId,
              text: `Go with the recommended option: ${t.options.find((o) => o.id === t.recommendedId)?.label ?? t.recommendedId}.`,
            },
          ];
    case "report": {
      const scene = t.ref && !/^[0-9a-f]{8}$/.test(t.ref) ? t.ref : undefined;
      if (scene && (ctx.redos.get(scene) ?? 0) < 1)
        return [
          {
            kind: "redo",
            scenes: [scene],
            why: t.report.couldnt || t.report.needs || `the ${t.from} reported ${t.report.status}`,
          },
        ];
      return [
        { kind: "hold", why: `the ${t.from} couldn't finish: ${t.report.couldnt || t.report.did}`.slice(0, 280) },
      ];
    }
    case "blocker":
      return t.scenes.every((s) => (ctx.redos.get(s) ?? 0) < 1)
        ? [{ kind: "redo", scenes: t.scenes, why: t.text.join(" ").slice(0, 380) }]
        : [{ kind: "hold", why: `the Reviewer still sees: ${t.text[0]}`.slice(0, 280) }];
    case "stage":
      return [{ kind: "next" }];
  }
}

export class PipConductor implements Conductor {
  private gateway: Gateway;
  private modeFor: (model: string) => "agent" | "menu";
  /** model calls made (tests count them) */
  calls = 0;
  constructor(o: { gateway: Gateway; modeFor: (model: string) => "agent" | "menu" }) {
    this.gateway = o.gateway;
    this.modeFor = o.modeFor;
  }

  async think(
    p: OpenProject,
    t: Trigger,
    ctx: { change?: ChangePlan; redos: Map<string, number>; replan?: boolean },
  ): Promise<Decision[]> {
    const model = this.gateway.modelFor("assistant", p.doc().crew.models);
    if (this.modeFor(model) !== "agent") return rules(t, ctx);
    try {
      return await this.loop(p, t, ctx, model);
    } catch (e: any) {
      if (e?.code === "budget") throw e;
      return rules(t, ctx);
    }
  }

  /** the plan's live tasks, one line each, so crew_replan can name them */
  plan?: (p: OpenProject) => string;

  private async loop(p: OpenProject, t: Trigger, ctx: { redos: Map<string, number>; replan?: boolean }, model: string) {
    const c = card("assistant", "conduct");
    const d = p.doc();
    const st = p.state;
    const project = [
      `"${d.title}": ${d.brief.idea.slice(0, 300)}`,
      `Stage ${st.stage}. Scenes: ${d.scenes
        .map(
          (s) =>
            `${s.id} [${s.kind === "decl" ? s.recipes.map((r) => r.id).join("+") : "code"}] redos ${ctx.redos.get(s.id) ?? 0}/2`,
        )
        .join("; ")}`,
      `Person's open requests: ${
        st.notes
          .filter((n) => n.by === "user" && n.status !== "done")
          .map((n) => `${n.id} (${n.assignee}): ${n.text.slice(0, 160)}`)
          .join("; ") || "none"
      }`,
      ...(ctx.replan && this.plan ? [`Plan (live tasks): ${this.plan(p) || "none"}`] : []),
      `Decisions on the brief: ${
        d.notes
          .map((n) => n.text)
          .slice(-8)
          .join("; ") || "none"
      }`,
    ].join("\n");
    const channel =
      p
        .channel()
        .slice(-10)
        .map((m) => `${m.from} → ${m.to} (${m.kind}): ${m.text.slice(0, 200)}`)
        .join("\n") || "(none)";
    const messages: ChatMessage[] = [
      { role: "user", content: fill(c.user, { trigger: describe(t), project, channel }) },
    ];
    const out: Decision[] = [];
    for (let step = 0; step < 3; step++) {
      this.calls++;
      const { result } = await this.gateway.chat({
        project: p.id,
        capUsd: d.budget.capUsd,
        task: `conduct-${t.kind}`,
        taskKind: "assistant.conduct",
        role: "assistant",
        promptVersion: c.version,
        system: c.system,
        messages,
        // crew_replan only while the run has Pip proposals left (§1.6)
        tools: ctx.replan ? TOOLS : TOOLS.filter((x) => x.name !== "crew_replan"),
        maxOut: c.maxOut,
        effort: c.effort,
        model,
      });
      messages.push({
        role: "assistant",
        content: result.assistant ?? result.toolCalls.map((x) => ({ type: "tool_call" as const, ...x })),
      });
      if (!result.toolCalls.length) break;
      let terminal = false;
      for (const call of result.toolCalls) {
        const schema = DecisionIn[call.name as keyof typeof DecisionIn];
        const parsed = schema?.safeParse(call.input);
        if (!parsed?.success) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: "invalid input",
            isError: true,
          });
          continue;
        }
        const v = parsed.data as any;
        out.push(
          call.name === "crew_brief"
            ? { kind: "brief", role: v.role, text: v.text, ref: v.ref }
            : call.name === "crew_answer"
              ? { kind: "answer", askId: v.askId, text: v.text, optionId: v.optionId }
              : call.name === "crew_redo"
                ? { kind: "redo", scenes: v.scenes, why: v.why }
                : call.name === "crew_reboard"
                  ? { kind: "reboard", scenes: v.scenes, direction: v.direction }
                  : call.name === "crew_next"
                    ? { kind: "next", why: v.why }
                    : call.name === "crew_hold"
                      ? { kind: "hold", why: v.why }
                      : call.name === "crew_replan"
                        ? { kind: "replan", diff: v }
                        : { kind: "escalate", question: v.question, options: v.options },
        );
        if (TERMINAL.has(call.name)) terminal = true;
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "ok" });
      }
      if (terminal) break;
    }
    return out.length ? out : rules(t, ctx);
  }
}
