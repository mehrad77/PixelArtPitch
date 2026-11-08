// What needs the person, in the order the simple view asks it (NeedsYouCard): open gates first, each with the question
// that is its real choice, then the other open questions (oldest first), then narration to record, then a problem
// only the person can fix. Pure functions, no React.
import { GATE_STAGE } from "./derive.ts";
import { askedByGate, needsNarration, problemOf } from "./human.ts";
import type { Gate, GateId, ProjectState, QuestionT } from "./types.ts";

export type NeedsItem =
  /** `pick`: the question the gate's items point to (G1's "which angle?"); the gate is answered by picking */
  | { key: string; kind: "gate"; gate: Gate; pick?: QuestionT }
  | { key: string; kind: "question"; q: QuestionT }
  | { key: string; kind: "narration" }
  | { key: string; kind: "problem" };

const GATE_ORDER: GateId[] = ["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"];

/**
 * A pick: a one-of question whose options are the real alternatives (the script angles), shown all at once with
 * "Use this one" on each. A gate's own question is one; so is the Writer's single-choice question that blocks the
 * script (a run whose G1 isn't open yet). The Producer's brief questions keep the recommended-first card.
 */
export const isPick = (q: QuestionT, s: ProjectState) =>
  q.kind === "single" &&
  q.options.length > 1 &&
  (askedByGate(s).has(q.id) || (q.blocks.includes("script") && q.from === "writer"));

export function needsItems(s: ProjectState): NeedsItem[] {
  const own = askedByGate(s);
  const gates = s.gates
    .filter((g) => g.status === "open")
    .sort((a, b) => GATE_ORDER.indexOf(a.id) - GATE_ORDER.indexOf(b.id))
    .map((gate): NeedsItem => {
      const pick = s.questions.find((q) => own.has(q.id) && gate.items.some((i) => i.ref === q.id));
      return { key: `g:${gate.id}`, kind: "gate", gate, ...(pick ? { pick } : {}) };
    });
  const qs = s.questions
    .filter((q) => q.status === "open" && !own.has(q.id))
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt))
    .map((q): NeedsItem => ({ key: `q:${q.id}`, kind: "question", q }));
  const nar: NeedsItem[] = needsNarration(s) ? [{ key: "narration", kind: "narration" }] : [];
  // a question that blocks a gate's stage is the real choice behind that gate ("which angle?" before "happy with
  // the script?"): it goes just ahead of its gate
  const out: NeedsItem[] = [];
  const used = new Set<string>();
  for (const g of gates) {
    if (g.kind !== "gate") continue;
    for (const q of qs)
      if (q.kind === "question" && !used.has(q.key) && q.q.blocks.includes(GATE_STAGE[g.gate.id])) {
        out.push(q);
        used.add(q.key);
      }
    out.push(g);
  }
  const all = [...out, ...qs.filter((q) => !used.has(q.key)), ...nar];
  // a problem only the person can fix: the status line carries it alone; behind other asks it waits in the queue
  if (all.length && problemOf(s)) all.push({ key: "problem", kind: "problem" });
  return all;
}

/**
 * The picture beside an item: a gate's item ref is a scene id (a frame from its middle), a file under `out/` (the
 * rough cut's contact sheet), or a question id (no picture); a question shows its member's latest picture.
 */
export function previewOf(
  item: NeedsItem,
  s: ProjectState,
  urls: { frame: (t: number) => string; file: (name: string) => string },
): string | undefined {
  if (item.kind === "gate") {
    for (const { ref } of item.gate.items) {
      if (!ref) continue;
      if (ref.startsWith("out/")) return urls.file(ref.slice(4));
      const sc = s.timeline.scenes.find((x) => x.id === ref);
      if (sc) return urls.frame((sc.from + sc.to) / 2) || undefined;
    }
    return undefined;
  }
  if (item.kind === "question")
    return [...s.tasks].reverse().find((t) => t.role === item.q.from && t.lastImage)?.lastImage;
  return undefined;
}
