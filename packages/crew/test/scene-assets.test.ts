// The Scene Coder's asset lines say which way a character's art faces and what each asset is (v0.5.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assetLines } from "../src/scene-code.ts";

test("asset lines name a character's facing and a one-line description", () => {
  const rows = ["....", "...."];
  const lines = assetLines(
    {
      assets: [
        ["hero", { idle0: rows, run0: rows }],
        ["npc", { idle0: rows }],
        ["logo", { icon: rows }],
      ],
      about: {
        hero: { kind: "character", description: "A hero in a hoodie. More detail here.", facing: "right" },
        npc: { kind: "character", description: "" },
        logo: { kind: "icon", description: "The person's logo." },
      },
    },
    ["hero", "npc", "logo", "nope"],
  );
  assert.deepEqual(lines, [
    "hero (4x2, faces right): idle0, run0 (A hero in a hoodie.)",
    "npc (4x2, faces left): idle0",
    "logo (4x2): icon (The person's logo.)",
  ]);
});
