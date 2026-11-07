import { z } from "zod";
import { ModelGateway } from "../src/gateway-impl.ts";
import { AnglesOut } from "../src/outputs.ts";
import { card, fill } from "../src/prompts.ts";

const g = new ModelGateway();
const c = card("writer", "angles");
const vars = {
  brief: {
    idea: "QuestDay is a to-do app that turns every task into a quest: clear tasks, collect stars, raise your flag. 15-second launch teaser. CTA questday.example",
  },
  lengthSec: 15,
  speechSec: 11,
  wordBudget: 24,
  mustSay: "",
};
try {
  const out = await g.json({
    project: "debug",
    capUsd: 1,
    task: "dbg",
    taskKind: "writer.angles",
    role: "writer",
    promptVersion: c.version,
    system: fill(c.system, vars),
    messages: [{ role: "user", content: fill(c.user, vars) }],
    schema: AnglesOut,
    jsonSchema: z.toJSONSchema(AnglesOut) as any,
    maxOut: c.maxOut,
  });
  console.log("OK", JSON.stringify(out.data));
} catch (e: any) {
  console.log("ERR", e.message, "\nISSUES", e.issues, "\nRAW", JSON.stringify(e.raw)?.slice(0, 1500));
}
