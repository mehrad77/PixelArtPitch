// pap report over a small fictional project: the summary snapshot, the run window, and what never reaches the page.
// UPDATE_SNAPSHOT=1 node --test packages/report/test/report.test.ts rewrites test/fixtures/summary.json.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "@pap/crew/llm/ledger";
import { buildReport, errorKind, summarize } from "../src/index.ts";

const FIX = join(import.meta.dirname, "fixtures");
const SNAPSHOT = join(FIX, "summary.json");

/** a copy of the fixture with what git can't hold (out/, private/, a symlink into private/) and a ledger built by crew */
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "pap-report-"));
  const dir = join(tmp, "nightkite");
  cpSync(join(FIX, "nightkite"), dir, { recursive: true });
  mkdirSync(join(dir, "out"));
  cpSync(join(dir, "assets", "kite.png"), join(dir, "out", "contact.png"));
  writeFileSync(join(dir, "out", "nightkite_teaser.mp4"), "");
  mkdirSync(join(dir, "private"));
  cpSync(join(dir, "assets", "badge.png"), join(dir, "private", "secret-ref.png"));
  symlinkSync(join(dir, "private", "secret-ref.png"), join(dir, "runs", "sneak-v1.png"));
  const ledger = join(tmp, "ledger.sqlite");
  const db = new Ledger(ledger);
  for (const c of JSON.parse(readFileSync(join(FIX, "ledger.json"), "utf8")))
    db.insert({
      project: c.project ?? "nightkite_teaser",
      task: c.task,
      taskKind: c.taskKind,
      role: c.role,
      attempt: 1,
      provider: "anthropic",
      model: c.model,
      promptVersion: c.promptVersion,
      usage: { inputTokens: c.inputTokens, outputTokens: c.outputTokens, thinkingTokens: c.thinkingTokens },
      usd: c.usd,
      usdSource: "table",
      ttftMs: 500,
      durationMs: c.durationMs,
      stop: c.stop,
      estUsd: null,
      ts: c.ts,
    });
  db.close();
  return { tmp, dir, ledger };
}

const opts = (ledger: string) => ({ ledger, notes: join(FIX, "findings.md"), picks: join(FIX, "picks.jsonl") });

test("the summary matches its snapshot", () => {
  const { dir, ledger } = setup();
  const { summary } = summarize(dir, opts(ledger));
  if (process.env.UPDATE_SNAPSHOT || !existsSync(SNAPSHOT))
    writeFileSync(SNAPSHOT, `${JSON.stringify(summary, null, 2)}\n`);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("lanes follow role order, failures come from error kinds", () => {
  const { dir, ledger } = setup();
  const { summary: s } = summarize(dir, opts(ledger));
  assert.deepEqual(
    s.lanes.map((l) => l.name),
    ["Writer", "Pixel artist · kite", "Pixel artist · lamp", "Animator · sky", "Animator · end", "Reviewer"],
  );
  assert.deepEqual(
    s.incidents.map((i) => i.label),
    ["Rejected by the standard", "Key rejected", "Run failed: The animator got stuck."],
  );
  assert.deepEqual(
    s.fail.kinds.map((k) => k.kind),
    ["limit", "auth", "standard"],
  );
  assert.equal(s.total, 0.49, "only this project's calls");
  assert.deepEqual(
    s.you.map((w) => w.title),
    ["Gate g1_script", "Gate g3_rough"],
  );
  assert.equal(s.thinking?.role, "pixel-artist");
  assert.equal(errorKind("the person paused it"), null);
  assert.equal(errorKind("fetch failed"), "unreachable");
});

test("--run narrows to one run's window, and an unknown run says which exist", () => {
  const { dir, ledger } = setup();
  const { summary: s } = summarize(dir, { ledger, run: "run_b" });
  assert.deepEqual(
    s.lanes.map((l) => l.name),
    ["Reviewer"],
  );
  assert.equal(s.ncalls, 1);
  assert.throws(
    () => summarize(dir, { ledger, run: "run_zz" }),
    (e: any) => /run_a, run_b/.test(e.fix),
  );
});

test("keys, private files and private assets never reach the page", () => {
  const { tmp, dir, ledger } = setup();
  const out = join(tmp, "report");
  const r = buildReport(dir, { ...opts(ledger), out });
  const names = r.images.map((i) => i.name).sort();
  assert.deepEqual(
    names,
    ["img/asset-kite.png", "img/lamp-v1.png"],
    "no private badge, contact sheet or symlinked file",
  );
  assert.ok(!r.html.includes("sk-ant"), "the key in the 401 message is redacted");
  assert.ok(!r.html.includes("FAKEFAKE"));
  assert.ok(!r.html.includes("should never be read"), "Pip's trace is never read");
  assert.ok(!r.html.includes(dir), "no absolute project path");
  assert.equal(r.html.split("</script>").length - 1, 2, "the embedded data cannot close its script tag");
  const badge = r.summary.assets.find((a) => a.id === "badge")!;
  assert.equal(badge.private, true);
  assert.deepEqual(badge.images, []);
  assert.equal(badge.description, "");
  assert.deepEqual(r.summary.outputs, [{ file: "", label: "The last cut, one frame per scene", private: true }]);
  assert.ok(existsSync(join(out, "index.html")));
  assert.ok(existsSync(join(out, "img", "lamp-v1.png")));
  assert.ok(!existsSync(join(out, "img", "asset-badge.png")));

  const all = buildReport(dir, { ledger, includePrivate: true });
  assert.deepEqual(
    all.images.map((i) => i.name).sort(),
    ["img/asset-badge.png", "img/asset-kite.png", "img/contact.png", "img/lamp-v1.png"],
    "--include-private shows the badge and the contact sheet, never the file under private/",
  );
});
