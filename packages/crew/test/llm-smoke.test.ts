// Live smoke test: one tiny real Anthropic call. Runs only with PAP_SMOKE=1 and a key in the environment, keychain or
// secrets file. Spends well under a cent (Haiku 5.5, max_tokens 32) under a $0.25 cap.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnthropicProvider } from "../src/llm/anthropic.ts";
import { BudgetGuard, metered } from "../src/llm/budget.ts";
import { Ledger } from "../src/llm/ledger.ts";
import { priceFor } from "../src/llm/prices.ts";
import { DEFAULT_PROVIDERS, SecretStore } from "../src/llm/settings.ts";

const enabled = process.env.PAP_SMOKE === "1";
const config = DEFAULT_PROVIDERS.find((p) => p.kind === "anthropic")!;
const secrets = enabled ? new SecretStore() : null;
const hasKey = !!secrets?.hasKey(config);

test("live: one tiny Haiku 5.5 call under a $0.25 cap", {
  skip: !enabled || !hasKey ? "set PAP_SMOKE=1 and an Anthropic key" : false,
}, async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "pap-smoke-")), "ledger.sqlite"));
  const guard = new BudgetGuard({ project: "smoke", capUsd: 0.25, ledger });
  const provider = new AnthropicProvider(config, { getKey: () => secrets!.getKey(config) });
  const m = metered(provider, { guard, ledger, price: priceFor, task: "smoke", taskKind: "smoke", role: "system" });
  const r = await m.chat(
    {
      model: "anthropic/claude-haiku-5-5",
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      maxOut: 32,
      effort: "low",
      thinking: false,
    },
    {},
  );
  assert.ok(r.usage.inputTokens > 0);
  assert.ok(r.usage.outputTokens > 0);
  assert.ok(r.usd > 0 && r.usd < 0.25);
  assert.ok(["end", "max_tokens"].includes(r.stop));
  assert.equal(ledger.query({ project: "smoke" }).length, 1);
  assert.ok(guard.spentUsd <= 0.25);
});
