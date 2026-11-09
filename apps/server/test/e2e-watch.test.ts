// scripts/e2e/watch_filter.py, the filter behind `watch.sh --project`: one line per watched event in a project's
// runs/events.jsonl (finished tasks, open questions, gates, waiting status, whole dollars, crew reports, warn/error logs)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const e2e = fileURLToPath(new URL("../../../scripts/e2e/", import.meta.url));

test("the watch filter prints one line per watched event and skips the rest", () => {
  const r = spawnSync("python3", [`${e2e}watch_filter.py`], {
    input: readFileSync(`${e2e}test/events.jsonl`),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").slice(0, -1), [
    '18:00:02 task done: writer.angles "Writing three script angles" $0.06',
    '18:00:03 task failed: director.board "Boarding load_in" $0.50',
    '18:00:04 task fallback: artist.sprite "Drawing the roller" $1.25',
    "18:00:06 question q3: Your logo in the video. Use it?",
    "18:00:08 gate g1_script open",
    "18:00:09 gate g1_script passed",
    "18:00:10 gate g3_rough changes",
    "18:00:13 waiting (plan): Waiting for you: the plan change in Pip's thread",
    "18:00:15 spend passed $1 (now $1.05)",
    "18:00:17 spend passed $2 (now $3.40)",
    "18:00:17 spend passed $3 (now $3.40)",
    "18:00:18 report from writer: Wrote three angles.",
    "18:00:19 question from director: Three players or four?",
    "18:00:22 warn: Pip couldn't decide; holding",
    "18:00:23 error: render failed",
    '18:00:24 task fallback: artist.sprite "Partial walk cycle" $0.30',
  ]);
});
