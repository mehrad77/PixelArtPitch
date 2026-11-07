// The web's Settings save (src/lib/settings.ts) and the composer's live estimate (src/lib/brief.ts): saving the
// Defaults form keeps the fields it doesn't show, and one drawing per new asset costs less than two or three.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composerEstimate } from "../src/lib/brief.ts";
import { mergeSettings } from "../src/lib/settings.ts";
import { MockClient } from "../src/mock/client.ts";
import { SETTINGS } from "../src/mock/fixtures.ts";

test("mergeSettings keeps pipPlan, reviewRounds, the effort ceiling and variants when the form saves four fields", () => {
  const cur = structuredClone(SETTINGS);
  cur.defaults = { ...cur.defaults, pipPlan: "on", reviewRounds: 1, effortCeiling: "high", variants: 3 };
  const next = mergeSettings(cur, { defaults: { capUsd: 9, askAtFraction: 0.5, involvement: "auto", concurrency: 2 } });
  assert.equal(next.defaults.capUsd, 9);
  assert.equal(next.defaults.pipPlan, "on");
  assert.equal(next.defaults.reviewRounds, 1);
  assert.equal(next.defaults.effortCeiling, "high");
  assert.equal(next.defaults.variants, 3);
  assert.deepEqual(next.paths, cur.paths);
});

test("the mock's saveSettings deep-merges defaults too", async () => {
  const c = new MockClient();
  const before = await c.settings();
  await c.saveSettings({ defaults: { ...before.defaults, reviewRounds: 1 } });
  const after = await c.saveSettings({
    defaults: { capUsd: 3, askAtFraction: 0.8, involvement: "key", concurrency: 3 },
  });
  assert.equal(after.defaults.capUsd, 3);
  assert.equal(after.defaults.reviewRounds, 1, "the second save kept the first one's reviewRounds");
  assert.equal(after.defaults.pipPlan, before.defaults.pipPlan);
});

test("the composer's estimate follows the drawings per new asset live", () => {
  const at = (variants: number) =>
    composerEstimate({ profile: "best", lengthSec: 30, involvement: "key", variants }).usd[0];
  assert.ok(at(1) < at(2) && at(2) < at(3), `${at(1)} < ${at(2)} < ${at(3)}`);
  assert.equal(at(2), composerEstimate({ profile: "best", lengthSec: 30, involvement: "key" }).usd[0]);
});
