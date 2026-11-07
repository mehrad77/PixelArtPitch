// What the orchestrator needs from the model layer: pick a model for a role, run one schema-bound call under the
// project's budget, and record it in the ledger. Implemented over packages/crew/src/llm (see gateway-impl.ts).
import type { RoleT } from "@pap/schema";
import type { z } from "zod";
import type { Caps, ChatMessage, ChatResult, StreamEvent, ToolSpec } from "./llm/types.ts";

export type CallSpec<T> = {
  project: string;
  capUsd: number;
  task: string;
  taskKind: string;
  role: RoleT;
  promptVersion: string;
  system: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** JSON Schema of `schema` for providers (built by the caller with z.toJSONSchema) */
  jsonSchema: Record<string, unknown>;
  maxOut: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  /** force a specific model id instead of the role's */
  model?: string;
  /** no escalation to the role's fallback on a failure (Pip's plan revision: one call, one repair, then the rules) */
  noFallback?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: StreamEvent) => void;
  normalize?: (raw: unknown) => T | null;
};

export type Measure = {
  count: import("./llm/types.ts").CountInfo | null;
  window: { tokens: number; source: "provider" | "table"; detail: string; note?: string } | null;
  /** real prompt tokens ÷ our estimate over this model's recent calls */
  calibration: { ratio: number; n: number } | null;
};

export type CallOut<T> = { data: T; result: ChatResult; model: string };

/** One metered chat step with tools (Pip's tool loop). No fallback here: the caller picks the model per turn. */
export type ChatSpec = Omit<CallSpec<unknown>, "schema" | "jsonSchema" | "normalize"> & {
  tools?: ToolSpec[];
  /** false: turn thinking off where the model allows it */
  thinking?: boolean;
};

export interface Gateway {
  /** "<provider>/<model>" for a role in a project (project override, then settings profile) */
  modelFor(role: RoleT, projectModels?: Record<string, string>): string;
  caps(model: string): Caps | null;
  json<T>(spec: CallSpec<T>): Promise<CallOut<T>>;
  /** a metered, lane-scheduled chat step that passes tools; tool_choice is always left to the model ("auto") */
  chat(spec: ChatSpec): Promise<{ result: ChatResult; model: string }>;
  /** the role's fallback model, if any */
  fallbackFor(role: RoleT): string | undefined;
  spent(project: string): { spentUsd: number; reservedUsd: number };
  /** measure a request without running it (free count endpoints, the provider's window, our calibration) */
  measure?(req: import("./llm/types.ts").ChatRequest): Promise<Measure>;
  /** ledger spend for a project since an ISO time (the workspace guard's daily cap) */
  spentSince?(project: string, since: string): number;
  /** concurrent calls per endpoint (the lane size: local 1, else defaults.concurrency) */
  laneSize?(providerId: string): number;
  /** a model on a local endpoint (its calls are free, one at a time) */
  isLocal?(model: string): boolean;
  /** the crew defaults from settings (pipPlan, reviewRounds) */
  defaults?(): { pipPlan?: "on" | "shadow" | "off"; reviewRounds?: 1 | 2 };
  /** the ledger, for estimates from observed calls */
  ledgerRef?(): import("./llm/ledger.ts").Ledger;
  estimate(
    project: string,
    tasks: { kind: string; role: RoleT; count?: number }[],
  ): { usd: [number, number]; sec: [number, number] } | null;
}
