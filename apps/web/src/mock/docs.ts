// The Docs page on the mock (?mock=1): a few of the repo's real docs (their text read with `?raw`, their listing
// entries and the whole tool list generated from the server's code by scripts/docs-fixture.ts), and the person's
// connections from the shared mock backend, so Settings › Connections and Docs agree. With none yet, one fictional
// server ("tune-finder") is added once through the same mock API, as if the person had pasted it.
import { ApiError } from "../lib/api.ts";
import { client } from "../lib/client.ts";
import type { ConnDoc, ConnToolDoc, DocEntry, DocFile, DocsApi, ToolDoc } from "../lib/docs.ts";
import type { Connection } from "../lib/types.ts";
import fixture from "./docs-tools.json";

/** keep in step with MOCK_DOCS in scripts/docs-fixture.ts */
const RAW: Record<string, () => Promise<{ default: string }>> = {
  "README.md": () => import("../../../../README.md?raw"),
  "AGENTS.md": () => import("../../../../AGENTS.md?raw"),
  "docs/GLOSSARY.md": () => import("../../../../docs/GLOSSARY.md?raw"),
  "docs/STYLE-GUIDE.md": () => import("../../../../docs/STYLE-GUIDE.md?raw"),
  "docs/roles/writer.md": () => import("../../../../docs/roles/writer.md?raw"),
  "docs/roles/reviewer.md": () => import("../../../../docs/roles/reviewer.md?raw"),
  "skills/pap-writer/SKILL.md": () => import("../../../../skills/pap-writer/SKILL.md?raw"),
};

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: text.slice(m[0].length) };
}

// ---- the fictional connection's tools (FAKE_TOOLS in mock/pip.ts names them) ----
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: "object", required, properties });
const FAKE: Record<string, Omit<ConnToolDoc, "approval" | "fields">> = {
  search: {
    name: "search",
    title: "Search tunes",
    description: "Search the tune catalogue by mood, tempo or words. Returns ids, titles and lengths.",
    readOnly: true,
    destructive: false,
    inputSchema: obj(["q"], {
      q: { type: "string", description: "words to look for, e.g. 'night drive'" },
      mood: { type: "string", enum: ["calm", "bright", "tense", "dreamy"], description: "only tunes with this mood" },
      bpm_max: { type: "integer", description: "the fastest tempo to return" },
      limit: { type: "integer", default: 10, description: "how many results, at most 50" },
    }),
  },
  get_item: {
    name: "get_item",
    title: "Get a tune",
    description: "One tune by id: title, length, licence and a preview link.",
    readOnly: true,
    destructive: false,
    inputSchema: obj(["id"], { id: { type: "string", description: "an id from search" } }),
  },
  list_recent: {
    name: "list_recent",
    description: "The tunes added to the catalogue this week, newest first.",
    readOnly: true,
    destructive: false,
    inputSchema: obj([], { limit: { type: "integer", default: 20 } }),
  },
  download: {
    name: "download",
    description: "Download a tune's file into the project's inbox, ready for the Mixer.",
    readOnly: false,
    destructive: false,
    inputSchema: obj(["id"], {
      id: { type: "string" },
      format: { type: "string", enum: ["wav", "mp3"], default: "wav" },
    }),
  },
  describe: {
    name: "describe",
    description: "Describe a tune in words: mood, instruments and where it peaks.",
    readOnly: true,
    destructive: false,
    inputSchema: obj(["id"], { id: { type: "string" } }),
  },
  tag: {
    name: "tag",
    description: "Add tags to a tune in your catalogue.",
    readOnly: false,
    destructive: false,
    inputSchema: obj(["id", "tags"], { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } }),
  },
};

/** the same fields the server reads off a schema (top level is enough for these) */
const fieldsOf = (s: any) =>
  Object.entries<any>(s.properties ?? {}).map(([name, v]) => ({
    name,
    type: v.type === "array" ? `array of ${v.items?.type ?? "any"}` : (v.type ?? "any"),
    required: (s.required ?? []).includes(name),
    ...(v.description ? { description: v.description } : {}),
    ...(v.enum ? { enum: v.enum } : {}),
    ...("default" in v ? { default: v.default } : {}),
  }));

function connDoc(c: Connection): ConnDoc {
  const trust = c.trust === "read_only" ? "read" : "ask";
  let runs = "";
  if (c.transport === "http") {
    try {
      runs = new URL(c.url ?? "").origin;
    } catch {}
  } else runs = (c.command ?? "").split("/").pop() ?? "";
  const status = !c.enabled || c.status === "off" ? "off" : c.status === "failed" ? "failed" : "connected";
  return {
    name: c.name,
    description: c.transport === "http" ? new URL(c.url ?? "http://x").hostname : (c.command ?? ""),
    transport: c.transport,
    runs,
    status,
    trust,
    ...(status === "failed"
      ? { error: "It didn't connect.", fix: "open Settings › Connections and press Test to see the whole error" }
      : {}),
    tools:
      status === "connected"
        ? c.tools.map((name) => {
            const t = FAKE[name] ?? { name, description: name, readOnly: false, destructive: false, inputSchema: {} };
            return { ...t, approval: !(trust === "read" && t.readOnly), fields: fieldsOf(t.inputSchema) };
          })
        : [],
  };
}

/** the one seeding, shared by every call (React's dev double effects call twice at once) */
let seeding: Promise<unknown> | null = null;
const seed = () =>
  client.addConnections(
    JSON.stringify({
      mcpServers: {
        "tune-finder": {
          command: "npx",
          args: ["-y", "tune-finder-mcp"],
          env: { TUNE_FINDER_KEY: "mock-not-a-real-key" },
        },
      },
    }),
  );

export const mockDocs: DocsApi = {
  async docs() {
    await later(150);
    return structuredClone(fixture.docs) as DocEntry[];
  },
  async doc(path: string): Promise<DocFile> {
    await later(120);
    const entry = fixture.docs.find((d) => d.path === path);
    const raw = RAW[path];
    if (!entry || !raw)
      throw new ApiError(404, {
        code: "not_found",
        message: `no doc ${path.slice(0, 120)}`,
        fix: "use a path from GET /api/docs, such as docs/API.md or README.md",
      });
    const { meta, body } = frontMatter((await raw()).default);
    return { ...entry, markdown: body, meta };
  },
  async tools() {
    await later(150);
    return structuredClone(fixture.tools) as ToolDoc[];
  },
  async connections() {
    if (!seeding) seeding = client.connections().then((l) => (l.length ? null : seed()));
    await seeding;
    return (await client.connections()).map(connDoc);
  },
};
