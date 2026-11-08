// The one tool registry. Every capability (read a project, patch it, render a still, search the library, ask the user)
// is a tool defined here once and reached three ways: by the in-app crew's agent loop, by MCP clients, and by the UI
// (POST /api/p/:id/tools/:name). Inputs and outputs are zod schemas, so all three get the same JSON Schema and the
// same validation, and errors come back with a `fix` hint a small model can act on.
import type { AuthorT, RoleT } from "@pap/schema";
import { z } from "zod";
import type { OpenProject, Workspace } from "./store.ts";

export type ToolEffects = "read" | "write" | "spend" | "destructive";
export type ToolTier = "basic" | "advanced";

export type ToolImage = { mediaType: "image/png"; data: Uint8Array; caption?: string };

export type ToolOk<O> = { ok: true; data: O; images?: ToolImage[]; rev?: number };
export type ToolErr = {
  ok: false;
  error: { code: string; message: string; path?: string; fix?: string; retryable?: boolean };
};
export type ToolResult<O> = ToolOk<O> | ToolErr;

/** What a handler can reach. The server builds one per call. */
export interface ToolContext {
  author: AuthorT;
  signal?: AbortSignal;
  /** the open project this call is about (tools with `project: false` get none) */
  project?: OpenProject;
  workspace: Workspace;
  /** push a progress or log line to the UI/agent */
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

// ---- questions (the decision cards) ----
export const QuestionOption = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(80),
  detail: z.string().max(300).default(""),
  costUsd: z.number().optional(),
  timeSec: z.number().optional(),
});
export const QuestionInput = z.object({
  kind: z.enum(["single", "multi", "yesno", "number", "image"]).default("single"),
  question: z.string().min(5).max(200),
  why: z.string().max(400).default(""),
  options: z.array(QuestionOption).min(2).max(6),
  recommendedId: z.string(),
  /** task ids or stage names this blocks */
  blocks: z.array(z.string()).default([]),
  /** what happens if nobody answers: the recommended option is taken after this many seconds (null: wait) */
  timeoutSec: z.number().int().positive().nullable().default(null),
  from: z.string().default("producer"),
  /** the plan's `rights` node for a likeness or logo (PIP-JOURNEY N15): only the person answers it, never a timeout */
  rights: z.object({ asset: z.string(), private: z.literal(true) }).optional(),
  /**
   * the crew is held on this question (PIP-ORCHESTRATION §1.8): answering it lifts the hold and acts on the choice.
   * An option that can't act yet (`fix_key`, `tell` without words in `note`) leaves it open.
   */
  hold: z.boolean().optional(),
});
export type QuestionInput = z.input<typeof QuestionInput>;
export const Question = QuestionInput.extend({
  id: z.string(),
  askedAt: z.string(),
  status: z.enum(["open", "answered", "defaulted", "withdrawn"]),
  answer: z
    .object({
      optionId: z.string().optional(),
      value: z.unknown().optional(),
      note: z.string().optional(),
      by: z.string(),
    })
    .optional(),
});
export type QuestionT = z.infer<typeof Question>;

// ---- definitions ----
export type ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  /** one or two sentences; what it does and when to use it. Shown to models and in MCP. */
  description: string;
  input: I;
  output: O;
  /** roles that may call it; "*" for all, [] for user/MCP only */
  roles: RoleT[] | "*";
  tier: ToolTier;
  effects: ToolEffects;
  /** needs an open project */
  project: boolean;
  /** worked examples (validated in tests) */
  examples?: { input: z.input<I>; note?: string }[];
  /** rough cost/time hint for budgeting */
  cost?: (input: z.infer<I>) => { usd?: number; sec?: number };
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<ToolResult<z.infer<O>>>;
};

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`tool name must be snake_case: ${def.name}`);
  return def;
}

export const ok = <O>(data: O, extra: Omit<ToolOk<O>, "ok" | "data"> = {}): ToolOk<O> => ({ ok: true, data, ...extra });
export const fail = (
  code: string,
  message: string,
  more: Omit<ToolErr["error"], "code" | "message"> = {},
): ToolErr => ({
  ok: false,
  error: { code, message, ...more },
});

export class Registry {
  private tools = new Map<string, ToolDef<any, any>>();
  add(...defs: ToolDef<any, any>[]) {
    for (const d of defs) {
      if (this.tools.has(d.name)) throw new Error(`duplicate tool ${d.name}`);
      this.tools.set(d.name, d);
    }
    return this;
  }
  get(name: string) {
    return this.tools.get(name);
  }
  list(filter: { role?: RoleT; tier?: ToolTier } = {}) {
    return [...this.tools.values()].filter(
      (t) =>
        (!filter.role || t.roles === "*" || t.roles.includes(filter.role)) &&
        (!filter.tier || filter.tier === "advanced" || t.tier === "basic"),
    );
  }
  /** JSON Schema of a tool's input, for model tool definitions and MCP */
  inputSchema(name: string) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" });
  }
  outputSchema(name: string) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return z.toJSONSchema(t.output, { unrepresentable: "any" });
  }
  /** validate, check role and project, run, validate output; never throws */
  async call(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> {
    const t = this.tools.get(name);
    if (!t)
      return fail("unknown_tool", `no tool named ${name}`, {
        fix: `valid tools: ${[...this.tools.keys()].join(", ")}`,
      });
    if (ctx.author.kind === "agent" && t.roles !== "*" && !t.roles.includes(ctx.author.role as RoleT))
      return fail("forbidden", `${ctx.author.role} may not call ${name}`);
    if (t.project && !ctx.project)
      return fail("no_project", `${name} needs an open project`, { fix: "pass project_id" });
    const parsed = t.input.safeParse(rawInput);
    if (!parsed.success)
      return fail("invalid_input", "the input does not match the schema", {
        fix: parsed.error.issues
          .slice(0, 10)
          .map((i: z.core.$ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
        retryable: true,
      });
    try {
      const res = await t.handler(parsed.data, ctx);
      if (res.ok) {
        const out = t.output.safeParse(res.data);
        if (!out.success) return fail("bad_output", `${name} produced an invalid result`, { fix: out.error.message });
        return { ...res, data: out.data };
      }
      return res;
    } catch (e: any) {
      return fail(e?.code ?? "error", String(e?.message ?? e), { fix: e?.fix, path: e?.path });
    }
  }
}
