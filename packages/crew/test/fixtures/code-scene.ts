// A QuestDay scene drawn by code, with named constants at the top (the edit tests and Pip's tests share it).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenProject } from "@pap/tools";

/** a QuestDay scene drawn by code with named constants at the top */
export const QUEST_CODE = `import { rect, skyGradient, text, walk } from "pap:engine";
import { E, S } from "pap:timeline";
export const BOARD_X = 120;
export const BOARD_Y = 40;
export const TITLE = "QUESTS";
export function draw(t) {
  skyGradient();
  rect(BOARD_X, BOARD_Y, 80, 50, "k");
  text(TITLE, BOARD_X + 40, BOARD_Y + 6, { align: "center", colour: "B" });
  walk("hero", { x0: 60, x1: 60, t0: S("c02"), t1: E("c02"), t, face: "right" });
}
`;

/** QuestDay's "quest" scene as a code scene drawn by QUEST_CODE (or `code`) */
export async function withCodeScene(p: OpenProject, code = QUEST_CODE) {
  mkdirSync(join(p.dir, "code"), { recursive: true });
  writeFileSync(join(p.dir, "code", "quest.mjs"), code);
  const k = p.doc().scenes.findIndex((s) => s.id === "quest");
  const sc = p.doc().scenes[k] as any;
  await p.patch(
    [
      { op: "add", path: "/code/-", value: { id: "quest", file: "code/quest.mjs", fullFrame: false, sfx: false } },
      {
        op: "replace",
        path: `/scenes/${k}`,
        value: {
          ...sc,
          recipes: undefined,
          layers: undefined,
          camera: undefined,
          id: "quest",
          kind: "code",
          bundle: "quest",
          title: sc.title || "One quest board",
          beat: "the quest board",
          assets: ["hero"],
        },
      },
    ],
    { reason: "a code scene", author: { kind: "user" } },
  );
  return k;
}
