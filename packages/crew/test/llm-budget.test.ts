import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetGuard, metered } from "../src/llm/budget.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { Ledger } from "../src/llm/ledger.ts";
import { BudgetError } from "../src/llm/types.ts";

process.env.PAP_HOME = mkdtempSync(join(tmpdir(), "pap-budget-"));
const freshLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "pap-ledger-")), "ledger.sqlite"));

test("cap $1, ten concurrent $0.30 calls: at most 3 admitted, settled total <= cap", async () => {
  const guard = new BudgetGuard({ project: "p1", capUsd: 1, floorUsd: 0 });
  const fake = new FakeProvider(() => ({ text: "ok", usd: 0.21, delayMs: 20 }));
  let admitted = 0;
  let rejected = 0;
  const calls = Array.from({ length: 10 }, async () => {
    let t: ReturnType<BudgetGuard["reserve"]>;
    try {
      t = guard.reserve(0.3);
    } catch (e) {
      assert.ok(e instanceof BudgetError);
      rejected++;
      return;
    }
    admitted++;
    const r = await fake.chat({ model: "fake/model", messages: [{ role: "user", content: "hi" }], maxOut: 10 });
    guard.settle(t, r.usd);
  });
  await Promise.all(calls);
  assert.equal(admitted, 3);
  assert.equal(rejected, 7);
  assert.ok(guard.spentUsd <= 1);
  assert.equal(Number(guard.spentUsd.toFixed(6)), 0.63);
  assert.equal(guard.reservedUsd, 0);
});

test("aborted calls release their reservations (metered provider)", async () => {
  const ledger = freshLedger();
  const guard = new BudgetGuard({ project: "p2", capUsd: 1, ledger });
  // price chosen so a 30-token-ish request with maxOut 15000 costs about $0.30 worst case
  const price = { inPerMTok: 0, outPerMTok: 20, source: "manual" as const };
  const fake = new FakeProvider(() => ({ text: "late", usd: 0.1, delayMs: 200 }));
  const m = metered(fake, {
    guard,
    ledger,
    price: () => price,
    task: "t",
    taskKind: "asset.draw",
    role: "pixel-artist",
  });
  const ac = new AbortController();
  const req = { model: "fake/model", messages: [{ role: "user" as const, content: "x" }], maxOut: 15_000 };
  const runs = Array.from({ length: 10 }, () =>
    m.chat(req, { signal: ac.signal }).then(
      () => "done",
      (e) => e,
    ),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(guard.reservedUsd, 0.9);
  assert.equal(ledger.openReservations("p2").length, 3);
  ac.abort();
  const out = await Promise.all(runs);
  assert.equal(out.filter((e) => e instanceof BudgetError).length, 7);
  assert.equal(out.filter((e) => e instanceof Error && e.name === "AbortError").length, 3);
  assert.equal(guard.reservedUsd, 0);
  assert.equal(guard.spentUsd, 0);
  assert.equal(ledger.openReservations("p2").length, 0);
});

test("settled calls land in the ledger; unsettled reservations count as spent after a restart", async () => {
  const ledger = freshLedger();
  const g1 = new BudgetGuard({ project: "p3", capUsd: 2, ledger });
  const fake = new FakeProvider(() => ({ text: "ok", usd: 0.25 }));
  const m = metered(fake, {
    guard: g1,
    ledger,
    price: () => ({ inPerMTok: 1, outPerMTok: 10, source: "manual" }),
    task: "draw hero",
    taskKind: "asset.draw",
    role: "pixel-artist",
  });
  await m.chat({ model: "fake/model", messages: [{ role: "user", content: "x" }], maxOut: 1000 }, {});
  const rows = ledger.query({ project: "p3" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 0.25);
  assert.ok(rows[0].ticket);
  // a call in flight when the process died
  g1.reserve(0.5);
  const g2 = new BudgetGuard({ project: "p3", capUsd: 2, ledger });
  assert.equal(g2.spentUsd, 0.75);
  g2.forgetOrphans();
  assert.equal(g2.spentUsd, 0.25);
});

test("onThreshold fires once at the ask point", () => {
  const seen: number[] = [];
  const g = new BudgetGuard({ project: "p4", capUsd: 1, askAtFraction: 0.8, onThreshold: (f) => seen.push(f) });
  const a = g.reserve(0.5);
  g.settle(a, 0.5);
  assert.deepEqual(seen, []);
  const b = g.reserve(0.35);
  assert.equal(seen.length, 1);
  g.settle(b, 0.3);
  g.reserve(0.05);
  assert.equal(seen.length, 1);
});

test("the floor is never admitted", () => {
  const g = new BudgetGuard({ project: "p5", capUsd: 1, floorUsd: 0.5 });
  g.reserve(0.3);
  assert.throws(() => g.reserve(0.3), BudgetError);
});
