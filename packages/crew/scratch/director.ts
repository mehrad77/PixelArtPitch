import { readFileSync } from "node:fs";
import { z } from "zod";
import { ModelGateway } from "../src/gateway-impl.ts";
import { StoryboardOut } from "../src/outputs.ts";
import { card, fill } from "../src/prompts.ts";

const g = new ModelGateway();
const c = card("director", "storyboard");
const { recipeCatalog } = await import("@pap/engine/recipes");
const catalog = recipeCatalog()
  .map((x: any) => `- ${x.id}: ${x.description}`)
  .join("\n");
const vars = {
  idea: "QuestDay: a to-do app that turns tasks into quests.",
  cues: "c01: Stop grinding through your to-do list.\nc02: QuestDay turns every task into a quest.\nc03: Clear tasks, collect stars, raise your flag.\nc04: Start your quest at questday.example",
  recipes: catalog,
  assets: "mentor-ai: character 16x24\nitems: icon 12x12 (pc, gamepad, heart, star)\ncastle: building\ngamers: crowd",
};
const t0 = Date.now();
try {
  const out = await g.json({
    model: process.argv[2],
    project: "debug",
    capUsd: 1,
    task: "dbg",
    taskKind: "director.storyboard",
    role: "director",
    promptVersion: c.version,
    system: fill(c.system, vars),
    messages: [{ role: "user", content: fill(c.user, vars) }],
    schema: StoryboardOut,
    jsonSchema: z.toJSONSchema(StoryboardOut) as any,
    maxOut: c.maxOut,
    effort: c.effort,
  });
  console.log(
    "OK",
    Math.round((Date.now() - t0) / 1000) + "s",
    JSON.stringify(out.data).slice(0, 900),
    JSON.stringify(out.result.usage),
  );
} catch (e: any) {
  console.log(
    "ERR",
    Math.round((Date.now() - t0) / 1000) + "s",
    e.message,
    e.issues,
    JSON.stringify(e.raw)?.slice(0, 500),
    JSON.stringify(e.result?.usage),
  );
}
