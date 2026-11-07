import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelsFor } from "../src/llm/roles.ts";
import {
  defaultSettings,
  type ExecLike,
  loadSettings,
  localProfile,
  PROFILES,
  publicSettings,
  SecretStore,
  saveSettings,
} from "../src/llm/settings.ts";
import type { Caps, ModelInfo } from "../src/llm/types.ts";

const home = mkdtempSync(join(tmpdir(), "pap-settings-"));
process.env.PAP_HOME = home;

const KEY = "sk-ant-SECRET-1234567890";
const noKeychain: ExecLike = () => {
  throw new Error("no keychain");
};

test("keys never appear in serialized settings, on disk or in the UI shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "pap-s1-"));
  const secrets = new SecretStore({ env: {}, exec: noKeychain, keychain: true, dir });
  assert.equal(secrets.setKey("anthropic", KEY), "file");
  assert.equal(secrets.getKey({ id: "anthropic", kind: "anthropic" }), KEY);
  const s = defaultSettings();
  // a key smuggled into a provider entry is stripped by the schema
  (s.providers[0] as any).apiKey = KEY;
  saveSettings(s, dir);
  const onDisk = readFileSync(join(dir, "settings.json"), "utf8");
  assert.ok(!onDisk.includes(KEY));
  const pub = publicSettings(loadSettings(dir), secrets);
  const json = JSON.stringify(pub);
  assert.ok(!json.includes(KEY));
  assert.equal(pub.providers.find((p) => p.id === "anthropic")?.hasKey, true);
  assert.equal(pub.providers.find((p) => p.id === "openai")?.hasKey, false);
  // the secrets file is 0600, and only it holds the key
  assert.equal(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600);
  for (const f of readdirSync(dir)) {
    if (f !== "secrets.json") assert.ok(!readFileSync(join(dir, f), "utf8").includes(KEY), f);
  }
});

test("secret lookup order: env, then keychain, then file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pap-s2-"));
  const calls: string[][] = [];
  const exec: ExecLike = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "find-generic-password") return "from-keychain\n";
    return "";
  };
  const p = { id: "anthropic", kind: "anthropic" as const };
  assert.equal(
    new SecretStore({ env: { ANTHROPIC_API_KEY: "from-env" }, exec, keychain: true, dir }).getKey(p),
    "from-env",
  );
  assert.equal(calls.length, 0);
  const s = new SecretStore({ env: {}, exec, keychain: true, dir });
  assert.equal(s.getKey(p), "from-keychain");
  assert.deepEqual(calls[0], ["security", "find-generic-password", "-s", "pixelartpitch", "-a", "anthropic", "-w"]);
  assert.equal(s.setKey("openrouter", "or-key"), "keychain");
  assert.deepEqual(calls.at(-1)?.slice(0, 7), [
    "security",
    "add-generic-password",
    "-U",
    "-s",
    "pixelartpitch",
    "-a",
    "openrouter",
  ]);
  const fileOnly = new SecretStore({ env: {}, keychain: false, dir });
  fileOnly.setKey("ollama", "local-key");
  assert.equal(fileOnly.getKey({ id: "ollama", kind: "ollama" }), "local-key");
  fileOnly.deleteKey("ollama");
  assert.equal(fileOnly.hasKey({ id: "ollama", kind: "ollama" }), false);
});

test("profiles: Best and Balanced role assignments", () => {
  assert.equal(PROFILES.best.director.model, "anthropic/claude-opus-5-5");
  assert.equal(PROFILES.best.writer.model, "anthropic/claude-sonnet-5-5");
  assert.equal(PROFILES.best.librarian.model, "anthropic/claude-haiku-5-5");
  assert.equal(PROFILES.balanced.reviewer.model, "anthropic/claude-opus-5-5");
  assert.equal(PROFILES.balanced["pixel-artist"].model, "anthropic/claude-opus-5-5");
  assert.equal(PROFILES.balanced.director.model, "anthropic/claude-sonnet-5-5");
  const opusRoles = Object.values(PROFILES.balanced).filter((r) => r.model.includes("opus"));
  assert.equal(opusRoles.length, 2);
});

const caps = (over: Partial<Caps>): Caps => ({
  vision: "unknown",
  structured: "unknown",
  tools: "unknown",
  longOutput: "unknown",
  thinking: "none",
  caching: false,
  ctx: 32_000,
  maxOut: 8_000,
  concurrency: 1,
  local: true,
  ...over,
});
const model = (id: string, c: Partial<Caps>): ModelInfo => ({
  id: `lmstudio/${id}`,
  provider: "lmstudio",
  model: id,
  label: id,
  caps: caps(c),
  price: null,
});

test("modelsFor explains what is hidden", () => {
  const models = [
    model("qwen-vl", { vision: "claimed" }),
    model("llama", { vision: "failed" }),
    model("phi", {}),
    model("coder", { vision: "failed", maxOut: 64_000 }),
  ];
  const art = modelsFor("art-director", models);
  assert.deepEqual(
    art.shown.map((m) => m.model),
    ["qwen-vl"],
  );
  assert.equal(art.summary, "3 hidden: no vision");
  const coder = modelsFor("scene-coder", models);
  assert.deepEqual(
    coder.shown.map((m) => m.model),
    ["coder"],
  );
  assert.equal(coder.summary, "3 hidden: no long output");
  const weak = modelsFor("writer", [model("broken", { structured: "failed", tools: "failed" }), model("ok", {})]);
  assert.equal(weak.summary, "1 hidden: no structured output");
});

test("local profile picks the first enabled local provider's models per role", () => {
  const s = defaultSettings();
  const lm = s.providers.find((p) => p.id === "lmstudio")!;
  lm.enabled = true;
  const roles = localProfile(s.providers, [
    model("llama", { vision: "failed" }),
    model("qwen-vl", { vision: "claimed" }),
  ]);
  assert.ok(roles);
  assert.equal(roles.writer.model, "lmstudio/llama");
  assert.equal(roles.reviewer.model, "lmstudio/qwen-vl");
  assert.equal(localProfile(defaultSettings().providers, []), null);
});
