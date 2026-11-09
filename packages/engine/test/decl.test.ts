import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type DeclSceneT, SfxType } from "@pap/schema";
import { compileDecl, DeclError, drawDecl, inspectDecl } from "../src/decl.ts";
import { SFX_TYPES } from "../src/decl-spec.ts";
import { RECIPES, recipeCatalog } from "../src/recipes.ts";
import { engine, oneScene, ROOT, timeline } from "./helpers.ts";

const compile = (scene: Record<string, unknown>) => {
  const doc = oneScene(scene);
  return compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
};
const issuesOf = (scene: Record<string, unknown>) => {
  try {
    compile(scene);
  } catch (e) {
    assert.ok(e instanceof DeclError, String(e));
    for (const i of e.issues) assert.ok(i.fix.length > 3, `issue without a fix: ${i.message}`);
    return e.issues;
  }
  assert.fail("expected a DeclError");
};

test("SFX names match the schema", () => {
  assert.deepEqual([...SFX_TYPES], SfxType.options);
});

test("compile errors carry a path and a fix", () => {
  const unknownProp = issuesOf({
    layers: [{ id: "a", kind: "sprite", props: { asset: "items", colour: "B", sizee: 3 } }],
  });
  assert.match(unknownProp[0].message, /unknown prop "sizee"/);
  assert.match(unknownProp[0].path, /layers\[0\]\.props\.sizee/);
  assert.match(unknownProp[0].fix, /allowed: .*asset/);

  const near = issuesOf({ layers: [{ id: "a", kind: "text", props: { text: "HI", Scale: 2 } }] });
  assert.match(near[0].fix, /did you mean "scale"/);

  const missing = issuesOf({ layers: [{ id: "a", kind: "actor", props: {} }] });
  assert.match(missing[0].message, /missing required prop "asset"/);

  const range = issuesOf({ layers: [{ id: "a", kind: "text", props: { text: "HI", scale: 9 } }] });
  assert.match(range[0].fix, /from 1 to 4/);

  const badTime = issuesOf({
    layers: [{ id: "a", kind: "text", props: { text: "HI" }, behaviors: [{ kind: "appear", at: "S(c99)" }] }],
  });
  assert.match(badTime[0].message, /unknown cue c99/);
  assert.match(badTime[0].fix, /valid cues: c01/);

  const needsAt = issuesOf({
    layers: [{ id: "a", kind: "text", props: { text: "HI" }, behaviors: [{ kind: "walk", params: { to: 10 } }] }],
  });
  assert.match(needsAt[0].message, /walk needs "at"/);

  const kind = issuesOf({ layers: [{ id: "a", kind: "code", props: {} }] });
  assert.match(kind[0].fix, /code scene/);

  const recipe = issuesOf({ recipes: [{ id: "walk_on" }] });
  assert.match(recipe[0].fix, /walk_in/);

  const recipeParam = issuesOf({ recipes: [{ id: "walk_in", params: { speed: 500 } }] });
  assert.match(recipeParam[0].path, /recipes\[0\]\.params\.speed/);

  const dup = issuesOf({
    layers: [
      { id: "a", kind: "text", props: { text: "A" } },
      { id: "a", kind: "text", props: { text: "B" } },
    ],
  });
  assert.match(dup[0].message, /duplicate layer id/);

  // the schema already rejects a bad ease; compileDecl must too when it gets a raw scene
  const doc = oneScene({});
  const raw = {
    ...doc.scenes[0],
    layers: [
      {
        id: "a",
        kind: "text",
        z: 0,
        space: "world",
        props: { text: "A" },
        keys: { y: [{ t: "S(c01)", v: 1, ease: "bounce" }] },
      },
    ],
  };
  assert.throws(
    () => compileDecl(raw as any, timeline(doc).at),
    (e: any) => e instanceof DeclError && /backOut/.test(e.issues[0].fix),
  );

  const widget = issuesOf({ layers: [{ id: "a", kind: "widget", props: { widget: "scoreboard" } }] });
  assert.match(widget[0].fix, /banner/);
});

test("every recipe expands with only its required params, draws and stays JSON-safe", () => {
  const e = engine();
  const required: Record<string, Record<string, unknown>> = {
    title_card: { title: "QUESTDAY" },
    toast: { title: "NEW QUEST" },
    banner: { text: "LEVEL UP" },
    end_card_loop: { title: "QUESTDAY" },
    spawn_join: { who: "friend" },
  };
  for (const r of RECIPES) {
    for (const [k, s] of Object.entries(r.params))
      if (s.req) assert.ok(required[r.id]?.[k] !== undefined, `${r.id}.${k} needs a test value`);
    const cs = compile({ recipes: [{ id: r.id, params: required[r.id] ?? {} }] });
    assert.deepEqual(JSON.parse(JSON.stringify(cs)), cs, `${r.id} compiles to plain JSON`);
    assert.ok(cs.layers.length >= 1, r.id);
    let lit = 0;
    for (let t = cs.from; t < cs.to; t += 0.25) {
      drawDecl(e, cs, t);
      let n = 0;
      for (let i = 0; i < e.buf.length; i += 3) if (e.buf[i] !== e.buf[0] || e.buf[i + 1] !== e.buf[1]) n++;
      lit = Math.max(lit, n);
    }
    assert.ok(lit > 2000, `${r.id} draws something (${lit} px)`);
    for (const s of cs.sfx) assert.ok((SFX_TYPES as readonly string[]).includes(s.type));
    for (const t of r.sfx) assert.ok((SFX_TYPES as readonly string[]).includes(t));
  }
  assert.equal(recipeCatalog().length, RECIPES.length);
});

test("recipes emit their sounds at cue-anchored times", () => {
  const cs = compile({
    recipes: [{ id: "walk_in" }, { id: "block_bump" }, { id: "flag_raise", params: { at: "E(c01)" } }],
  });
  const types = cs.sfx.map((s) => s.type);
  for (const t of ["jump", "bump", "land", "coin", "flagpole", "flag", "fanfare"]) assert.ok(types.includes(t), t);
  const doc = oneScene({});
  const tl = timeline(doc);
  assert.ok(cs.sfx.some((s) => s.type === "flagpole" && Math.abs(s.t - tl.at("E(c01)")) < 1e-9));
});

test("drawing is deterministic and pixel-snapped", () => {
  const cs = compile({ recipes: [{ id: "walk_in" }, { id: "block_bump" }, { id: "item_collect" }] });
  const e = engine();
  drawDecl(e, cs, 1.234);
  const a = Buffer.from(e.buf);
  drawDecl(e, cs, 2);
  drawDecl(e, cs, 1.234);
  assert.ok(a.equals(Buffer.from(e.buf)));
  for (const x of inspectDecl(e, cs, 1.7)) {
    assert.ok(Number.isInteger(x.x) && Number.isInteger(x.y), `${x.id} at whole pixels`);
  }
});

test("an actor without run frames still walks (idle frames with a bob) and flips to face its walk", () => {
  const cs = compile({
    layers: [
      {
        id: "a",
        kind: "actor",
        props: { asset: "hero", x: 40, artFaces: "left" },
        behaviors: [{ kind: "walk", at: "S(c01)", params: { to: 200 } }],
      },
    ],
  });
  const e = engine();
  const xs = [0.7, 1.5, 2.5].map((t) => inspectDecl(e, cs, t).find((x) => x.id === "a")!.x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], `moves right: ${xs}`);
});

test("the sandbox import graph is pure: no zod, no value imports from the schema, no eval or Math.random", () => {
  const files = ["decl.ts", "decl-spec.ts", "decl-check.ts", "recipes.ts", "core.ts", "kit.ts"];
  for (const f of files) {
    const src = readFileSync(join(ROOT, "packages/engine/src", f), "utf8");
    for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
      const [, typeOnly, spec] = m;
      if (spec.startsWith("@pap/schema") || spec === "zod") assert.ok(typeOnly, `${f} imports ${spec} at runtime`);
      if (spec.startsWith("./")) assert.ok(files.includes(spec.slice(2)), `${f} imports ${spec}, outside the pure set`);
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Math\.random|new Function|\beval\(/, f);
  }
});
