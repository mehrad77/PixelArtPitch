// The Docs page's backend (docs/API.md "Docs"): the repo's Markdown docs, read-only from a fixed allow-list, and every
// tool the studio has: its own (the registry, as MCP serves it) and the ones from the person's connections.
// Pure over a `root` so tests can build a repo of their own (symlinks, traversal attempts).
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extDirect, PIP_ALWAYS } from "@pap/crew/assistant";
import type { Registry } from "@pap/tools";
import { z } from "zod";
import { mcpToolList } from "./mcp.ts";

export const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** folders never walked, besides anything the root .gitignore names */
const SKIP = new Set(["node_modules", "dist", "out", "private", "data", "coverage", "poc", "vendor", ".git"]);
const MAX_DEPTH = 6;
const MAX_BYTES = 1024 * 1024;

export type DocEntry = { path: string; group: string; title: string; summary: string };
export type DocFile = DocEntry & { markdown: string; meta: Record<string, string> };

class DocsError extends Error {
  code: string;
  status: number;
  fix: string;
  constructor(code: string, message: string, fix: string, status: number) {
    super(message);
    this.code = code;
    this.fix = fix;
    this.status = status;
  }
}

/** the root .gitignore's simple patterns (names and `*` globs), matched against every path segment */
function ignoredNames(root: string): RegExp[] {
  const f = join(root, ".gitignore");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.trim().replace(/\/$/, "").replace(/^\//, ""))
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !l.includes("/"))
    .map((l) => new RegExp(`^${l.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
}

/** whether a repo-relative path is a doc meant for reading */
function wanted(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (name === "README.md") return true;
  if (rel === "AGENTS.md") return true;
  if (parts[0] === "docs" && name.endsWith(".md")) return true;
  if (parts.length === 3 && parts[0] === "skills" && name === "SKILL.md") return true;
  return false;
}

/** every doc path under `root`, repo-relative with forward slashes; symlinks and project folders are never entered */
export function docPaths(root: string): string[] {
  const ignore = ignoredNames(root);
  const skip = (name: string) => SKIP.has(name) || ignore.some((r) => r.test(name));
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // a project folder (a pitch.json) holds the person's work, not docs
    if (rel && entries.some((e) => e.name === "pitch.json")) return;
    for (const e of entries) {
      if (e.isSymbolicLink() || skip(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r, depth + 1);
      else if (e.isFile() && wanted(r)) out.push(r);
    }
  };
  walk(root, "", 0);
  return out;
}

/** `---\nkey: value\n---` front matter (one-line values only), and the body after it */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

/** markdown syntax off a line, for a plain one-line summary */
const plain = (s: string) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** the title (first heading) and a one-line summary (front matter `description`, else the first paragraph) */
export function describe(path: string, text: string): { title: string; summary: string } {
  const { meta, body } = frontMatter(text);
  const lines = body.split(/\r?\n/);
  let title = "";
  let summary = meta.description ?? "";
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      if (!title) title = plain(h[1]);
      continue;
    }
    if (!summary && l.trim() && !/^\s*([|>-]|\*\s|\d+\.\s|<|!\[|\[!\[)/.test(l)) {
      const para = [l];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*(#|```|\||[-*]\s|\d+\.\s)/.test(lines[i + 1]))
        para.push(lines[++i]);
      summary = plain(para.join(" "));
    }
    if (title && summary) break;
  }
  const name = path.split("/").pop()!.replace(/\.md$/, "");
  return { title: title || name, summary: clip(summary) };
}

/** the folder a doc is listed under: skills/<role>/SKILL.md all sit under "skills" */
export const groupOf = (path: string) => {
  const parts = path.split("/");
  if (parts[0] === "skills" && parts.length === 3) return "skills";
  return parts.slice(0, -1).join("/");
};

const GROUP_ORDER = ["", "docs", "docs/roles", "skills"];
const rank = (g: string) => {
  const k = GROUP_ORDER.indexOf(g);
  return k < 0 ? GROUP_ORDER.length : k;
};

/** GET /api/docs */
export function listDocs(root: string): DocEntry[] {
  return docPaths(root)
    .map((path) => {
      let text = "";
      try {
        text = readFileSync(join(root, path), "utf8").slice(0, 64 * 1024);
      } catch {}
      return { path, group: groupOf(path), ...describe(path, text) };
    })
    .sort((a, b) => {
      if (a.group !== b.group) return rank(a.group) - rank(b.group) || a.group.localeCompare(b.group);
      const ra = /(^|\/)(README|AGENTS)\.md$/.test(a.path) ? 0 : 1;
      const rb = /(^|\/)(README|AGENTS)\.md$/.test(b.path) ? 0 : 1;
      return ra - rb || a.path.localeCompare(b.path);
    });
}

export const DocQuery = z.object({
  path: z
    .string()
    .min(1)
    .max(300)
    .refine((p) => !p.includes("\0"), "has a NUL byte"),
});

const EXAMPLE_FIX = "use a path from GET /api/docs, such as docs/API.md or README.md";

/** GET /api/docs/file?path=: only a listed doc, resolved, real path inside the repo, `.md`; never throws a raw fs error */
export function readDoc(root: string, raw: unknown): DocFile {
  const q = DocQuery.safeParse(raw);
  if (!q.success) throw new DocsError("bad_path", `path: ${q.error.issues[0]?.message ?? "invalid"}`, EXAMPLE_FIX, 400);
  const path = q.data.path;
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\\"))
    throw new DocsError("bad_path", "a doc path is repo-relative, with no .. and no backslash", EXAMPLE_FIX, 400);
  if (extname(path) !== ".md") throw new DocsError("bad_path", "only .md docs are served", EXAMPLE_FIX, 400);
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, path);
  const rel = relative(rootReal, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new DocsError("bad_path", "that path is outside the repo", EXAMPLE_FIX, 400);
  // the allow-list: the listing decides, so a gitignored, private or project file is never served
  if (!docPaths(root).includes(rel.split(sep).join("/")))
    throw new DocsError("not_found", `no doc ${path.slice(0, 120)}`, EXAMPLE_FIX, 404);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new DocsError("not_found", `no doc ${path.slice(0, 120)}`, EXAMPLE_FIX, 404);
  }
  if (!real.startsWith(rootReal + sep) || lstatSync(abs).isSymbolicLink())
    throw new DocsError("bad_path", "that doc points outside the repo", EXAMPLE_FIX, 400);
  if (lstatSync(real).size > MAX_BYTES)
    throw new DocsError("too_big", "that doc is over 1 MB", "open it in an editor instead", 413);
  const text = readFileSync(real, "utf8");
  const { meta, body } = frontMatter(text);
  const p = rel.split(sep).join("/");
  return { path: p, group: groupOf(p), ...describe(p, text), markdown: body, meta };
}

// ---------------------------------------------------------------- tools

/** one input field of a tool, read off its JSON Schema */
export type ToolField = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

const typeOf = (s: any): string => {
  if (!s || typeof s !== "object") return "any";
  if (s.const !== undefined) return `"${String(s.const)}"`;
  if (Array.isArray(s.enum)) return s.type && typeof s.type === "string" ? s.type : "enum";
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts)) {
    const parts = [...new Set(alts.map(typeOf))];
    const nul = parts.includes("null");
    const rest = parts.filter((p) => p !== "null");
    return `${rest.join(" | ") || "any"}${nul ? " or null" : ""}`;
  }
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "array") return `array of ${typeOf(s.items)}`;
  if (s.type === "object" && !s.properties && s.additionalProperties && typeof s.additionalProperties === "object")
    return `record of ${typeOf(s.additionalProperties)}`;
  return s.type ?? (s.$ref ? "object" : "any");
};

/** the readable fields of a JSON Schema: top level, then nested objects as `a.b` and arrays of objects as `a[].b` */
export function schemaFields(schema: unknown, prefix = "", depth = 0): ToolField[] {
  const s = schema as any;
  if (!s || typeof s !== "object" || !s.properties || typeof s.properties !== "object") return [];
  const req = new Set<string>(Array.isArray(s.required) ? s.required : []);
  const out: ToolField[] = [];
  for (const [k, v] of Object.entries<any>(s.properties)) {
    const name = `${prefix}${k}`;
    const alts: any[] = v?.anyOf ?? v?.oneOf ?? [];
    const enumOf = Array.isArray(v?.enum) ? v.enum : alts.flatMap((a) => (Array.isArray(a?.enum) ? a.enum : []));
    out.push({
      name,
      type: typeOf(v),
      required: req.has(k),
      ...(typeof v?.description === "string" ? { description: v.description } : {}),
      ...(enumOf.length ? { enum: enumOf } : {}),
      ...(v && "default" in v ? { default: v.default } : {}),
    });
    if (depth >= 2) continue;
    if (v?.type === "object") out.push(...schemaFields(v, `${name}.`, depth + 1));
    else if (v?.type === "array" && v.items?.type === "object")
      out.push(...schemaFields(v.items, `${name}[].`, depth + 1));
  }
  return out;
}

export type ToolDoc = {
  name: string;
  title: string;
  description: string;
  tier: string;
  effects: string;
  /** "*" for every crew role; [] for you and MCP clients only */
  roles: "*" | string[];
  project: boolean;
  /** Pip proposes it as a card you confirm (it writes, spends or deletes), instead of running it */
  approval: boolean;
  inputSchema: Record<string, unknown>;
  fields: ToolField[];
  examples: { input: unknown; note?: string }[];
};

/** GET /api/docs/tools: every registry tool, in the shape MCP lists it plus what the registry knows */
export function toolDocs(registry: Registry): ToolDoc[] {
  const mcp = new Map(mcpToolList(registry).map((t) => [t.name, t]));
  return registry
    .list()
    .map((t) => {
      const m = mcp.get(t.name)!;
      return {
        name: t.name,
        title: t.title,
        description: t.description,
        tier: t.tier,
        effects: t.effects,
        roles: t.roles === "*" ? ("*" as const) : [...t.roles],
        project: t.project,
        approval: t.effects !== "read" && t.name !== PIP_ALWAYS,
        inputSchema: m.inputSchema,
        fields: schemaFields(m.inputSchema),
        examples: (t.examples ?? []).map((e) => ({ input: e.input, ...(e.note ? { note: e.note } : {}) })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- connections

export type ConnToolDoc = {
  name: string;
  title?: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  /** Pip asks you with a card before calling it (everything but a read-only tool on a connection trusted for reads) */
  approval: boolean;
  inputSchema: Record<string, unknown>;
  fields: ToolField[];
};
export type ConnDoc = {
  name: string;
  description: string;
  transport: "stdio" | "http";
  /** stdio: the program's name only (never its arguments); http: the origin only (never a path, query or login) */
  runs: string;
  status: "connected" | "off" | "failed";
  trust: "ask" | "read";
  error?: string;
  fix?: string;
  tools: ConnToolDoc[];
};

/** what a connection's tools look like before they're shaped for the page */
export type RawConnTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

/** the safe face of a program or URL: no arguments, no path, no query, no user:password */
export function safeRuns(transport: "stdio" | "http", command?: string, url?: string): string {
  if (transport === "http") {
    try {
      return new URL(url ?? "").origin;
    } catch {
      return "";
    }
  }
  return (command ?? "").split(/[\\/]/).pop() ?? "";
}

export function connToolDoc(t: RawConnTool, trust: "ask" | "read"): ConnToolDoc {
  const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" };
  const readOnly = t.annotations?.readOnlyHint === true;
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: String(t.description ?? t.title ?? "").slice(0, 2000),
    readOnly,
    destructive: t.annotations?.destructiveHint === true,
    approval: !extDirect({
      name: t.name,
      server: "",
      tool: t.name,
      description: "",
      inputSchema: schema,
      readOnlyHint: readOnly,
      trust,
    }),
    inputSchema: schema,
    fields: schemaFields(schema),
  };
}
