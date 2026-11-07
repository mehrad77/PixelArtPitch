// The Docs page's data (docs/API.md "Docs"): the repo's Markdown docs, the studio's own MCP tools and the tools of
// the person's connections. Kept apart from the main Client: the mock answers from src/mock/docs.ts, the server
// from GET /api/docs*. Never carries a connection's secrets: the server sends only names, a program's name or a
// URL's origin, and each tool's schema.
import { ApiError } from "./api.ts";
import { client } from "./client.ts";
import type { ApiErrorBody } from "./types.ts";

export type DocEntry = { path: string; group: string; title: string; summary: string };
export type DocFile = DocEntry & { markdown: string; meta: Record<string, string> };

export type ToolField = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

export type ToolDoc = {
  name: string;
  title: string;
  description: string;
  tier: string;
  effects: string;
  /** "*" for every crew role; [] for you and MCP clients only */
  roles: "*" | string[];
  project: boolean;
  /** Pip proposes it as a card you confirm */
  approval: boolean;
  inputSchema: Record<string, unknown>;
  fields: ToolField[];
  examples: { input: unknown; note?: string }[];
};

export type ConnToolDoc = {
  name: string;
  title?: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  approval: boolean;
  inputSchema: Record<string, unknown>;
  fields: ToolField[];
};

export type ConnDoc = {
  name: string;
  description: string;
  transport: "stdio" | "http";
  runs: string;
  status: "connected" | "off" | "failed";
  trust: "ask" | "read";
  error?: string;
  fix?: string;
  tools: ConnToolDoc[];
};

export interface DocsApi {
  docs(): Promise<DocEntry[]>;
  doc(path: string): Promise<DocFile>;
  tools(): Promise<ToolDoc[]>;
  connections(): Promise<ConnDoc[]>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const err = (json as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(res.status, err ?? { code: `http_${res.status}`, message: res.statusText || "Request failed" });
  }
  return json as T;
}

const http: DocsApi = {
  docs: async () => (await get<{ docs: DocEntry[] }>("/api/docs")).docs,
  doc: (path) => get<DocFile>(`/api/docs/file?path=${encodeURIComponent(path)}`),
  tools: async () => (await get<{ tools: ToolDoc[] }>("/api/docs/tools")).tools,
  connections: async () => (await get<{ connections: ConnDoc[] }>("/api/docs/connections")).connections,
};

/** the mock loads only when asked, so the fixtures stay out of the main bundle */
const mock: DocsApi = {
  docs: async () => (await import("../mock/docs.ts")).mockDocs.docs(),
  doc: async (p) => (await import("../mock/docs.ts")).mockDocs.doc(p),
  tools: async () => (await import("../mock/docs.ts")).mockDocs.tools(),
  connections: async () => (await import("../mock/docs.ts")).mockDocs.connections(),
};

export const docsApi: DocsApi = client.mock ? mock : http;

// ---------------------------------------------------------------- the page's addresses

/** /docs/read/<path without .md> (a dot-free address, so a reload never looks like a file) */
export const docHref = (path: string, hash = "") =>
  `/docs/read/${path.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/")}${hash}`;
export const toolHref = (name: string) => `/docs/tools/${encodeURIComponent(name)}`;
export const connToolHref = (server: string, tool: string) =>
  `/docs/connections/${encodeURIComponent(server)}/${encodeURIComponent(tool)}`;

export type DocsRoute =
  | { kind: "index" }
  | { kind: "doc"; path: string }
  | { kind: "tool"; name: string }
  | { kind: "conn"; server: string; tool: string }
  | { kind: "missing" };

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** a /docs address to what it shows; null when it isn't a /docs address at all */
export function docsRoute(pathname: string): DocsRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "docs") return null;
  if (parts.length === 1) return { kind: "index" };
  if (parts[1] === "read" && parts.length > 2) return { kind: "doc", path: `${parts.slice(2).map(dec).join("/")}.md` };
  if (parts[1] === "tools" && parts.length === 3) return { kind: "tool", name: dec(parts[2]) };
  if (parts[1] === "connections" && parts.length === 4)
    return { kind: "conn", server: dec(parts[2]), tool: dec(parts[3]) };
  return { kind: "missing" };
}

/** a group's heading: the folder, or "Repo root" */
export const groupLabel = (g: string) => (g ? `${g}/` : "Repo root");

/** tools by the word before their first underscore: project_get, project_list → "project" */
export function byPrefix<T extends { name: string }>(tools: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const t of tools) {
    const k = t.name.split("_")[0];
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export const EFFECT_WORD: Record<string, string> = {
  read: "Reads only",
  write: "Writes",
  spend: "Spends money",
  destructive: "Deletes",
};

export const rolesWord = (r: "*" | string[]) =>
  r === "*" ? "Every crew role" : r.length ? r.join(", ") : "You and MCP clients only (no crew role)";
