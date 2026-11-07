// The Docs page's backend: the allow-list (which docs are listed, and nothing else is ever served: no `..`, absolute
// paths, non-.md files, symlinks out of the repo, gitignored or project files), the tool listing (the same tools and
// schemas MCP serves, plus the registry's metadata), and a connection's face (never a secret).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-docs-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildRegistry, Workspace } = await import("@pap/tools");
const { listDocs, readDoc, toolDocs, schemaFields, safeRuns, connToolDoc, describe } = await import("../src/docs.ts");
const { McpSession } = await import("../src/mcp.ts");
const { createApp } = await import("../src/app.ts");
const { Connections } = await import("../src/connections.ts");
const { SecretStore } = await import("@pap/crew/llm/index");

/** a small repo: docs that are listed, and files around them that must never be */
function makeRepo() {
  const root = mkdtempSync(join(home, "repo-"));
  const outside = mkdtempSync(join(home, "outside-"));
  const w = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  writeFileSync(join(outside, "secret.md"), "# Secret\n\nnot in the repo\n");
  w(".gitignore", "node_modules/\nscratch/\n*.log\n");
  w("README.md", "# The app\n\n![banner](docs/banner.png)\n\nShort videos, made by a crew.\n");
  w("AGENTS.md", "# AGENTS.md\n\nInstructions for coding agents.\n");
  w("CLAUDE.md", "@AGENTS.md\n");
  w("docs/API.md", "# Studio API\n\nThe local server.\n\n## Routes\n");
  w("docs/roles/writer.md", "# Writer\n\nPurpose: the script.\n");
  w(
    "skills/pap-writer/SKILL.md",
    "---\nname: pap-writer\ndescription: Act as the Writer.\n---\n\n# PAP Writer\n\nBody.\n",
  );
  w("packages/tools/README.md", "# Tools\n\nThe registry.\n");
  w("packages/tools/notes.md", "# Notes\n\nnot a README\n");
  w("packages/crew/prompts/x/plan.md", "# A prompt\n");
  w("node_modules/dep/README.md", "# dep\n");
  w("packages/x/dist/README.md", "# built\n");
  w("scratch/README.md", "# gitignored\n");
  w("private/README.md", "# private\n");
  w("poc/README.md", "# poc\n");
  w("vendor/README.md", "# vendor\n");
  w("examples/demo/pitch.json", "{}");
  w("examples/demo/README.md", "# a project folder\n");
  w("docs/notes.txt", "not markdown\n");
  symlinkSync(join(outside, "secret.md"), join(root, "docs", "leak.md"));
  symlinkSync(outside, join(root, "docs", "linked"));
  symlinkSync(outside, join(root, "skills", "pap-evil"));
  return { root, outside };
}

test("the listing: READMEs, AGENTS.md, docs/** and skills/*/SKILL.md, grouped, titled and summarised", () => {
  const { root } = makeRepo();
  const docs = listDocs(root);
  assert.deepEqual(
    docs.map((d) => d.path),
    [
      "AGENTS.md",
      "README.md",
      "docs/API.md",
      "docs/roles/writer.md",
      "skills/pap-writer/SKILL.md",
      "packages/tools/README.md",
    ],
  );
  const by = Object.fromEntries(docs.map((d) => [d.path, d]));
  assert.equal(by["README.md"].group, "");
  assert.equal(by["README.md"].title, "The app");
  assert.equal(by["README.md"].summary, "Short videos, made by a crew.");
  assert.equal(by["docs/roles/writer.md"].group, "docs/roles");
  assert.equal(by["skills/pap-writer/SKILL.md"].group, "skills");
  assert.equal(by["skills/pap-writer/SKILL.md"].title, "PAP Writer");
  assert.equal(by["skills/pap-writer/SKILL.md"].summary, "Act as the Writer.");
  assert.equal(describe("x.md", "no heading here\n").title, "x");
});

test("a doc opens with its body (front matter apart) and the same title", () => {
  const { root } = makeRepo();
  const d = readDoc(root, { path: "skills/pap-writer/SKILL.md" });
  assert.equal(d.meta.name, "pap-writer");
  assert.ok(d.markdown.startsWith("\n# PAP Writer") || d.markdown.startsWith("# PAP Writer"));
  assert.ok(!d.markdown.includes("description:"));
  assert.equal(readDoc(root, { path: "docs/API.md" }).title, "Studio API");
});

test("the allow-list: traversal, absolute paths, non-.md, symlinks and unlisted files are refused with a fix", () => {
  const { root, outside } = makeRepo();
  const refused = (path: unknown, code: string) => {
    assert.throws(
      () => readDoc(root, { path }),
      (e: any) => {
        assert.equal(e.code, code, `${String(path)}: ${e.message}`);
        assert.ok(e.fix && e.fix.includes("GET /api/docs"), "carries a fix");
        return true;
      },
    );
  };
  // traversal
  refused("../outside/secret.md", "bad_path");
  refused("docs/../../secret.md", "bad_path");
  refused("docs/..%2f..%2fsecret.md", "not_found");
  refused("docs\\..\\..\\secret.md", "bad_path");
  // absolute
  refused(join(outside, "secret.md"), "bad_path");
  refused("/etc/hosts.md", "bad_path");
  // not markdown
  refused("docs/notes.txt", "bad_path");
  refused("package.json", "bad_path");
  refused("README", "bad_path");
  // symlinks out of the repo: a linked file, a file in a linked folder, a linked skill
  refused("docs/leak.md", "not_found");
  refused("docs/linked/secret.md", "not_found");
  refused("skills/pap-evil/secret.md", "not_found");
  // in the repo but not a doc meant for reading
  refused("CLAUDE.md", "not_found");
  refused("packages/tools/notes.md", "not_found");
  refused("packages/crew/prompts/x/plan.md", "not_found");
  refused("node_modules/dep/README.md", "not_found");
  refused("packages/x/dist/README.md", "not_found");
  refused("scratch/README.md", "not_found");
  refused("private/README.md", "not_found");
  refused("poc/README.md", "not_found");
  refused("vendor/README.md", "not_found");
  refused("examples/demo/README.md", "not_found");
  refused("docs/missing.md", "not_found");
  // bad input
  refused("", "bad_path");
  refused(undefined, "bad_path");
  refused(42, "bad_path");
  refused("a\0.md", "bad_path");
  refused(`${"a/".repeat(200)}x.md`, "bad_path");
});

test("the real repo lists its own docs and none of the excluded folders", () => {
  const docs = listDocs(new URL("../../../", import.meta.url).pathname);
  const paths = docs.map((d) => d.path);
  for (const p of ["README.md", "AGENTS.md", "docs/API.md", "docs/roles/writer.md", "skills/pap-writer/SKILL.md"])
    assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => /(^|\/)(node_modules|dist|out|private|poc|vendor)\//.test(p)));
  assert.ok(!paths.some((p) => p.startsWith("examples/")), "project folders stay out");
  assert.ok(docs.every((d) => d.title && d.path.endsWith(".md")));
});

test("the tool listing: every registry tool, the same input schema MCP serves, the metadata and the examples", async () => {
  const registry = buildRegistry();
  const docs = toolDocs(registry);
  assert.equal(docs.length, registry.list().length);
  const s = new McpSession({ registry, workspace: new Workspace(() => []), version: "t" });
  const mcp = ((await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any).result.tools;
  assert.equal(mcp.length, docs.length);
  for (const t of mcp) {
    const d = docs.find((x) => x.name === t.name)!;
    assert.ok(d, t.name);
    assert.deepEqual(d.inputSchema, t.inputSchema, `${t.name}: same schema as MCP`);
    assert.equal(d.description, t.description);
    const def = registry.get(t.name)!;
    assert.equal(d.tier, def.tier);
    assert.equal(d.effects, def.effects);
    assert.equal(d.project, def.project);
    assert.equal(d.approval, def.effects !== "read" && def.name !== "feature_request");
    assert.deepEqual(d.roles, def.roles === "*" ? "*" : def.roles);
    assert.equal(d.examples.length, def.examples?.length ?? 0);
    // project tools take project_id first, as MCP clients see them
    if (def.project)
      assert.deepEqual(d.fields[0], {
        name: "project_id",
        type: "string",
        required: true,
        description: "id from project_list",
      });
  }
  assert.ok(
    docs.some((d) => d.examples.length > 0),
    "some tool has examples",
  );
});

test("schema fields: types, required, enums, defaults, nested objects and arrays of objects", () => {
  const fields = schemaFields({
    type: "object",
    required: ["a"],
    properties: {
      a: { type: "string", description: "the a" },
      mode: { type: "string", enum: ["x", "y"], default: "x" },
      n: { anyOf: [{ type: "number" }, { type: "null" }] },
      list: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
      obj: { type: "object", properties: { deep: { type: "boolean" } } },
      rec: { type: "object", additionalProperties: { type: "string" } },
    },
  });
  const by = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.deepEqual(by.a, { name: "a", type: "string", required: true, description: "the a" });
  assert.deepEqual(by.mode, { name: "mode", type: "string", required: false, enum: ["x", "y"], default: "x" });
  assert.equal(by.n.type, "number or null");
  assert.equal(by.list.type, "array of object");
  assert.deepEqual(by["list[].id"], { name: "list[].id", type: "string", required: true });
  assert.equal(by["obj.deep"].type, "boolean");
  assert.equal(by.rec.type, "record of string");
});

test("a connection's face never carries a secret: env, headers, args or a URL's login, path and query", async () => {
  const secretsDir = mkdtempSync(join(home, "secrets-"));
  const secrets = new SecretStore({ env: {}, keychain: false, dir: secretsDir });
  let saved: any[] = [];
  const conns = new Connections({ load: () => structuredClone(saved), save: (l) => (saved = l), secrets });
  // two servers that can't start or be reached, so nothing runs; their secrets go to the SecretStore
  await conns.add(
    JSON.stringify({
      mcpServers: {
        tunes: {
          command: "/opt/nowhere/bin/tunes-mcp-does-not-exist",
          args: ["--api-key=sk-ARG-SECRET-1", "serve"],
          env: { TUNES_KEY: "sk-ENV-SECRET-2" },
        },
        brandkit: {
          url: "http://user:PASS-SECRET-3@127.0.0.1:9/mcp/path?token=Q-SECRET-4",
          headers: { Authorization: "Bearer H-SECRET-5" },
        },
      },
    }),
  );
  conns.patch("brandkit", { enabled: false });
  const out = await conns.docs(2000);
  const json = JSON.stringify(out);
  for (const s of [
    "ARG-SECRET",
    "ENV-SECRET",
    "PASS-SECRET",
    "Q-SECRET",
    "H-SECRET",
    "TUNES_KEY",
    "Authorization",
    "serve",
    "/mcp/path",
    "user:",
  ])
    assert.ok(!json.includes(s), `leaks ${s}: ${json}`);
  const tunes = out.find((c) => c.name === "tunes")!;
  assert.equal(tunes.status, "failed");
  assert.equal(tunes.runs, "tunes-mcp-does-not-exist");
  assert.match(tunes.error!, /isn't installed/);
  assert.match(tunes.fix!, /Settings › Connections/);
  const brand = out.find((c) => c.name === "brandkit")!;
  assert.equal(brand.status, "off");
  assert.equal(brand.runs, "http://127.0.0.1:9");
  assert.deepEqual(brand.tools, []);
  assert.equal(safeRuns("http", undefined, "not a url"), "");
  conns.closeAll();
});

test("a connection's tools: fields and the card rule (only read-only tools on a read-trusted connection run alone)", () => {
  const t = {
    name: "search",
    description: "Find tunes",
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  };
  assert.equal(connToolDoc(t, "read").approval, false);
  assert.equal(connToolDoc(t, "ask").approval, true);
  assert.equal(connToolDoc({ ...t, annotations: {} }, "read").approval, true);
  assert.deepEqual(connToolDoc(t, "read").fields, [{ name: "q", type: "string", required: true }]);
});

test("the endpoints sit behind the studio's auth and Host checks, and errors carry a fix", async () => {
  const { root } = makeRepo();
  const registry = buildRegistry();
  const { app, token } = createApp({ port: 5999, workspace: new Workspace(() => []), registry, docsRoot: root });
  const get = (path: string, h: Record<string, string> = { host: "127.0.0.1:5999", cookie: `pap_session=${token}` }) =>
    app.request(path, { headers: h });
  assert.equal((await get("/api/docs", { host: "127.0.0.1:5999" })).status, 401);
  assert.equal((await get("/api/docs", { host: "evil.test", cookie: `pap_session=${token}` })).status, 421);
  assert.equal(
    (await get("/api/docs", { host: "127.0.0.1:5999", origin: "http://evil.test", cookie: `pap_session=${token}` }))
      .status,
    403,
  );
  const list = await (await get("/api/docs")).json();
  assert.equal(list.docs.length, 6);
  const f = await (await get("/api/docs/file?path=docs%2FAPI.md")).json();
  assert.equal(f.title, "Studio API");
  for (const [q, status] of [
    ["../x.md", 400],
    ["docs/leak.md", 404],
    ["package.json", 400],
    ["", 400],
  ] as const) {
    const r = await get(`/api/docs/file?path=${encodeURIComponent(q)}`);
    assert.equal(r.status, status, q);
    const b = await r.json();
    assert.equal(b.ok, false);
    assert.ok(b.error.fix, `${q}: a fix`);
  }
  assert.equal((await get("/api/docs/file")).status, 400);
  const tools = await (await get("/api/docs/tools")).json();
  assert.equal(tools.tools.length, registry.list().length);
  // no connections configured: an empty list, not an error
  assert.deepEqual(await (await get("/api/docs/connections")).json(), { connections: [] });
});

test("the Docs mock's fixture is still the real tool list and the real listing entries", async () => {
  const fixture = JSON.parse(
    (await import("node:fs")).readFileSync(new URL("../../web/src/mock/docs-tools.json", import.meta.url), "utf8"),
  );
  const { wireCrew } = await import("../src/wire.ts");
  const registry = buildRegistry();
  const w = await wireCrew({ workspace: new Workspace(() => []), registry, resume: false });
  const live = new Map(toolDocs(registry).map((t) => [t.name, t]));
  const fix = "regenerate it: node scripts/docs-fixture.ts";
  for (const t of fixture.tools) {
    const l = live.get(t.name);
    assert.ok(l, `${t.name} is no longer a tool; ${fix}`);
    assert.equal(t.effects, l.effects, `${t.name}: effects; ${fix}`);
    assert.equal(t.tier, l.tier, `${t.name}: tier; ${fix}`);
    assert.equal(t.approval, l.approval, `${t.name}: approval; ${fix}`);
  }
  const docs = new Map(listDocs(new URL("../../../", import.meta.url).pathname).map((d) => [d.path, d]));
  for (const d of fixture.docs) assert.equal(docs.get(d.path)?.title, d.title, `${d.path}; ${fix}`);
  w.connections.closeAll();
});
