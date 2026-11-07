// Prices per million tokens, and the cost formula.
//
// Source: the bundled Claude API skill (claude-api/shared/), not the live pricing page:
//   - models.md:79  Claude Opus 5.5    $4 / $20, cache reads $0.20
//   - models.md:85  Claude Sonnet 5.5  $2 / $10, cache reads $0.20
//   - models.md:87 and model-migration.md:2240  Claude Haiku 5.5  $0.10 / $0.50 when the prompt is <= 100K tokens,
//     $0.50 / $2.50 above; cache reads 0.1x input, 5-minute writes 1.25x, 1-hour writes 2x
//   - models.md:76  Claude Fable 5.1   $10 / $50, cache reads $0.25 (0.025x)
//   - prompt-caching.md:144  cache writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL
// Check https://platform.claude.com/docs/en/about-claude/pricing before budgeting on these; override with setPriceOverride.
import type { Price, Usage } from "./types.ts";

const card = (inPerMTok: number, outPerMTok: number, cacheReadPerMTok: number): Price => ({
  inPerMTok,
  outPerMTok,
  cacheReadPerMTok,
  cacheWritePerMTok: inPerMTok * 1.25,
  cacheWrite1hPerMTok: inPerMTok * 2,
  source: "table",
});

export const ANTHROPIC_PRICES: Record<string, Price> = {
  "claude-opus-5-5": card(4, 20, 0.2),
  "claude-sonnet-5-5": card(2, 10, 0.2),
  "claude-haiku-5-5": {
    ...card(0.1, 0.5, 0.01),
    longContext: {
      overPromptTokens: 100_000,
      inPerMTok: 0.5,
      outPerMTok: 2.5,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.625,
      cacheWrite1hPerMTok: 1,
    },
  },
  "claude-fable-5-1": card(10, 50, 0.25),
};

const overrides = new Map<string, Price>();

/** A manual price for a model id ("anthropic/claude-opus-5-5" or a bare model name); null clears it. */
export function setPriceOverride(modelId: string, price: Omit<Price, "source"> | null): void {
  if (price) overrides.set(modelId, { ...price, source: "manual" });
  else overrides.delete(modelId);
}

/** Manual override first, then the Anthropic table (by bare model name). Provider-reported prices live on ModelInfo. */
export function priceFor(modelId: string): Price | null {
  const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  return overrides.get(modelId) ?? overrides.get(bare) ?? ANTHROPIC_PRICES[bare] ?? null;
}

/** Input tokens that make up the prompt, which picks the rate card. */
export const promptTokens = (u: Usage): number => u.inputTokens + (u.cacheWriteTokens ?? 0) + (u.cacheReadTokens ?? 0);

function rates(price: Price, prompt: number) {
  const lc = price.longContext;
  if (lc && prompt > lc.overPromptTokens) {
    return {
      inP: lc.inPerMTok,
      outP: lc.outPerMTok,
      readP: lc.cacheReadPerMTok ?? lc.inPerMTok * 0.1,
      writeP: lc.cacheWritePerMTok ?? lc.inPerMTok * 1.25,
      write1hP: lc.cacheWrite1hPerMTok ?? lc.inPerMTok * 2,
    };
  }
  return {
    inP: price.inPerMTok,
    outP: price.outPerMTok,
    readP: price.cacheReadPerMTok ?? price.inPerMTok * 0.1,
    writeP: price.cacheWritePerMTok ?? price.inPerMTok * 1.25,
    write1hP: price.cacheWrite1hPerMTok ?? price.inPerMTok * 2,
  };
}

/** Cost in USD. cacheWriteTokens includes cacheWrite1hTokens; outputTokens includes thinking. */
export function costUsd(price: Price | null, u: Usage): number {
  if (!price) return 0;
  const r = rates(price, promptTokens(u));
  const w1h = u.cacheWrite1hTokens ?? 0;
  const w5m = Math.max(0, (u.cacheWriteTokens ?? 0) - w1h);
  return (
    (u.inputTokens * r.inP +
      w5m * r.writeP +
      w1h * r.write1hP +
      (u.cacheReadTokens ?? 0) * r.readP +
      u.outputTokens * r.outP) /
    1e6
  );
}

/** Worst case for one call: every input token at the dearer of the input and cache-write rates, plus maxOut. */
export function worstCaseUsd(price: Price | null, inputTokens: number, maxOut: number, cache = false): number {
  if (!price) return 0;
  const r = rates(price, inputTokens);
  return (inputTokens * (cache ? Math.max(r.inP, r.writeP) : r.inP) + maxOut * r.outP) / 1e6;
}
