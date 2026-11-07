// The plan evals runner (docs/PIP-ORCHESTRATION.md §5). Outside `pnpm check`: it spends money on a cloud model.
//   node packages/crew/evals/plan.ts --model <provider/model> [--cap 0.50] [--only <id>] [--dry]
// A temporary PAP_HOME with its own ledger; keys from the environment or the Keychain only, never written anywhere.
// --dry scores the rules plan only and prints what an Anthropic run would cost; it makes no model call.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pap-evals-"));
process.env.PAP_HOME = home;
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const model = arg("model") ?? "anthropic/claude-sonnet-5-5";
const cap = Number(arg("cap") ?? 0.5);
const only = arg("only");
const dry = process.argv.includes("--dry");

const { LIBRARY_DIR } = await import("@pap/render");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { defaultSettings, Ledger, PROFILES, SecretStore, priceFor } = await import("../src/llm/index.ts");
const { envOf, planEstimate } = await import("../src/plan/estimate.ts");
const { rulesPlan } = await import("../src/plan/rules.ts");
const { pipRevision, planPromptVars } = await import("../src/plan/pip.ts");
const { PlanEvalItem, aggregate, evalDoc, pipWins, scorePlan } = await import("../src/plan/evals.ts");

const items = readFileSync(new URL("./plan.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => PlanEvalItem.parse(JSON.parse(l)))
  .filter((x) => !only || x.id === only);
const lib = JSON.parse(readFileSync(join(LIBRARY_DIR, "index.json"), "utf8")).assets as {
  id: string;
  kind: string;
  tags?: string[];
}[];

const settings = defaultSettings();
const provider = model.slice(0, model.indexOf("/"));
settings.providers = settings.providers.map((p) => (p.id === provider ? { ...p, enabled: true } : p));
const gatewayFor = (profile: string) => {
  const s = structuredClone(settings);
  if (profile === "best" || profile === "balanced") s.roles = structuredClone(PROFILES[profile]) as any;
  if (profile === "local")
    for (const r of Object.keys(s.roles))
      s.roles[r] = { model: model.startsWith("lmstudio/") ? model : "lmstudio/local" };
  s.roles.assistant = { model };
  return new ModelGateway({
    ledger: new Ledger(join(home, "ledger.sqlite")),
    secrets: new SecretStore({ dir: home }),
    settings: s,
  });
};

const rulesScores = [];
const pipScores = [];
let calls = 0;
let spent = 0;
for (const item of items) {
  const doc = evalDoc(item);
  const gw = gatewayFor(item.profile);
  const env = envOf(gw);
  const ctx = { env, rev: 0 };
  const rules = rulesPlan(doc, ctx);
  const est = planEstimate(rules, 0, env);
  rulesScores.push(scorePlan(item, rules, { rules, p50: est.usd[0] }));
  if (dry) continue;
  if (spent >= cap) {
    console.log(`stopping: $${spent.toFixed(3)} spent of the $${cap} cap`);
    break;
  }
  const rctx = { ...ctx, rev: 1, refs: doc.brief.references };
  const res = await pipRevision({
    gateway: gw,
    project: "_evals",
    capUsd: cap,
    model,
    vars: planPromptVars({
      brief: { ...item.brief, style: item.brief.tone },
      refs: doc.brief.references.map((r) => ({ file: r.file, type: r.type, rights: r.rights })),
      library: lib,
      budget: { capUsd: doc.budget.capUsd, reserveUsd: doc.budget.reserveUsd, spentUsd: 0, estUsd: est.usd },
      tasks: rules,
      ctx: rctx,
    }),
    tasks: rules,
    ctx: rctx,
    validate: { doc, library: new Set(lib.map((a) => a.id)), env, spentUsd: 0 },
  });
  calls += res.calls;
  spent += res.usd;
  const tasks = res.tasks ?? rules;
  pipScores.push(
    scorePlan(item, tasks, {
      rules,
      p50: planEstimate(tasks, 0, env).usd[0],
      valid: res.valid,
      usd: res.usd,
      sec: res.sec,
    }),
  );
  console.log(`${item.id}: ${res.valid}${res.kept ? ` (kept: ${res.kept.slice(0, 80)})` : ""} ${res.summary}`);
}

const table = (name: string, s: typeof rulesScores) => {
  console.log(`\n${name}`);
  console.log("id".padEnd(28), "valid".padEnd(7), "miss", "extra", "p50".padStart(7), "estErr");
  for (const x of s)
    console.log(
      x.id.padEnd(28),
      x.valid.padEnd(7),
      String(x.missing).padStart(4),
      String(x.extra).padStart(5),
      `$${x.p50.toFixed(2)}`.padStart(7),
      x.estErr.toFixed(2),
    );
};
table("rules plan", rulesScores);
const ra = aggregate(rulesScores, 0);
console.log(JSON.stringify(ra));
if (!dry) {
  table(`rules + Pip (${model})`, pipScores);
  const pa = aggregate(pipScores, calls);
  console.log(JSON.stringify(pa));
  console.log(`Pip beats the rules plan: ${pipWins(ra, pa)} · ${calls} calls · $${spent.toFixed(4)}`);
  mkdirSync(join(home, "evals"), { recursive: true });
  const out = join(
    home,
    "evals",
    `plan-${model.replace(/[^a-z0-9.-]+/gi, "_")}-${new Date().toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(
    out,
    JSON.stringify({ model, rules: { items: rulesScores, ...ra }, pip: { items: pipScores, ...pa } }, null, 1),
  );
  console.log(`wrote ${out}`);
} else {
  // what one Pip call per item would cost on Anthropic, from the assistant.plan prior (declared: n = 0, so rough)
  const { estimateTask } = await import("../src/llm/estimator.ts");
  for (const m of ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"]) {
    const c = estimateTask({ kind: "assistant.plan", model: { id: m, price: priceFor(m) } });
    console.log(
      `${m}: about $${(c.usd[0] * items.length).toFixed(3)}-$${(c.usd[1] * items.length * 2).toFixed(3)} for ${items.length} items (p50 one call each; p90 with a repair each)`,
    );
  }
}
