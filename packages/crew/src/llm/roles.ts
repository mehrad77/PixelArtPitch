// What each crew role needs from a model, and which models qualify.
// Structured output is needed by every role, but the ladder (structured.ts) gets JSON out of any model through its
// prompt-only rungs, so "structured" only hides a model whose probe failed both native schema output and tool calls.
import { Role, type RoleT } from "@pap/schema";
import type { CapStatus, Caps, ModelInfo } from "./types.ts";

export const ROLES: readonly RoleT[] = Role.options;

export type Need = "vision" | "longOutput" | "structured";
export const ROLE_NEEDS: Record<RoleT, Need[]> = {
  producer: ["structured"],
  writer: ["structured"],
  director: ["vision", "structured"],
  "art-director": ["vision", "structured"],
  // critiques its own renders
  "pixel-artist": ["vision", "structured"],
  animator: ["structured"],
  "scene-coder": ["longOutput", "structured"],
  "sound-designer": ["structured"],
  mixer: ["structured"],
  editor: ["structured"],
  reviewer: ["vision", "structured"],
  librarian: ["structured"],
  // Pip: agent mode wants tools, but menu mode gets by on structured output alone
  assistant: ["structured"],
};

const ok = (s: CapStatus) => s === "passed" || s === "claimed";
const LABEL: Record<Need, string> = {
  vision: "no vision",
  longOutput: "no long output",
  structured: "no structured output",
};

export function missingNeeds(role: RoleT, caps: Caps): Need[] {
  return ROLE_NEEDS[role].filter((n) => {
    if (n === "vision") return !ok(caps.vision);
    if (n === "longOutput") return !(ok(caps.longOutput) || caps.maxOut >= 32_000);
    return caps.structured === "failed" && caps.tools === "failed";
  });
}

export type RoleModels = {
  shown: ModelInfo[];
  hidden: { model: ModelInfo; missing: Need[] }[];
  /** e.g. "3 hidden: no vision" or "3 hidden: 2 no vision, 1 no long output"; "" when nothing is hidden */
  summary: string;
};

export function modelsFor(role: RoleT, models: ModelInfo[]): RoleModels {
  const shown: ModelInfo[] = [];
  const hidden: RoleModels["hidden"] = [];
  for (const m of models) {
    const missing = missingNeeds(role, m.caps);
    if (missing.length) hidden.push({ model: m, missing });
    else shown.push(m);
  }
  const counts = new Map<Need, number>();
  for (const h of hidden) counts.set(h.missing[0], (counts.get(h.missing[0]) ?? 0) + 1);
  let summary = "";
  if (hidden.length) {
    summary =
      counts.size === 1
        ? `${hidden.length} hidden: ${LABEL[[...counts.keys()][0]]}`
        : `${hidden.length} hidden: ${[...counts].map(([n, c]) => `${c} ${LABEL[n]}`).join(", ")}`;
  }
  return { shown, hidden, summary };
}
