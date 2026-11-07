// A small MCP server (JSON-RPC 2.0) over the tool registry: tools, resources and prompts. Spoken over stdio
// (`pap mcp`) and Streamable HTTP (POST /mcp). No SDK: the firewall this was built behind blocks npm downloads, and
// the protocol surface we need is small.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Project } from "@pap/schema";
import type { Registry, ToolContext } from "@pap/tools";
import type { Workspace } from "@pap/tools/store";
import { z } from "zod";

export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DOCS_DIR = new URL("../../../docs/", import.meta.url).pathname;
const SKILLS_DIR = new URL("../../../skills/", import.meta.url).pathname;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
type RpcOut = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpDeps = { registry: Registry; workspace: Workspace; client?: string; version: string };

const PROMPTS = [
  {
    name: "start-project",
    title: "Start a pixel-art pitch",
    description: "Create a project from an idea, then let the crew make it.",
    arguments: [
      { name: "idea", description: "What the video is about and who it is for", required: true },
      { name: "seconds", description: "Target length in seconds (default 60)", required: false },
      { name: "budget", description: "Budget cap in US dollars (default 10)", required: false },
    ],
    text: (a: Record<string, string>) =>
      `Use PixelArtPitch to make a ${a.seconds ?? 60}-second pixel-art pitch video.\nIdea: ${a.idea}\n\n1. Call project_create with a short title, the brief (idea, lengthSec, narration) and budgetUsd ${a.budget ?? 10}.\n2. Call crew_run for the new project and watch crew_status; answer question_list items with question_answer.\n3. When the final gate opens, look at render_contact and approve or leave note_add notes.`,
  },
  {
    name: "draw-asset",
    title: "Draw a sprite to the PAP standard",
    description: "Draw a pixel sprite as letter grids on the PAP night palette and submit it.",
    arguments: [
      { name: "project_id", description: "Project id", required: true },
      { name: "description", description: "What to draw", required: true },
    ],
    text: (a: Record<string, string>) =>
      `Read pap://docs/PAP-STANDARD.md and pap://docs/ASSET-KINDS.md. Draw: ${a.description}. Use only palette letters, "." for transparent, light from the upper left, a 1 px dark outline. Submit with asset_submit to project ${a.project_id}; fix every hard issue it reports.`,
  },
  {
    name: "direct-scene",
    title: "Build a scene from recipes",
    description: "Fill one scene with recipes from the menu.",
    arguments: [
      { name: "project_id", description: "Project id", required: true },
      { name: "scene", description: "Scene id", required: true },
    ],
    text: (a: Record<string, string>) =>
      `Call project_get section "scene:${a.scene}" for project ${a.project_id}, then recipe_list. Pick recipes for the scene's cues, call scene_set_recipes, and check the result with render_still at the times it returns.`,
  },
  {
    name: "review-cut",
    title: "Review the cut",
    description: "Look at the video like a strict reviewer and leave timestamped notes.",
    arguments: [{ name: "project_id", description: "Project id", required: true }],
    text: (a: Record<string, string>) =>
      `For project ${a.project_id}: call render_contact, then render_still at each scene's start, middle and end. Report blockers (covered captions, clipped text, unreadable icons, overlaps) and polish, each with a time, as note_add notes. Read pap://docs/REVIEW-RUBRICS.md first.`,
  },
];

export class McpSession {
  private deps: McpDeps;
  initialized = false;
  protocol = MCP_VERSIONS[0];
  constructor(deps: McpDeps) {
    this.deps = deps;
  }

  private toolList() {
    return this.deps.registry.list().map((t) => {
      const schema: any = this.deps.registry.inputSchema(t.name);
      if (t.project) {
        schema.properties = {
          project_id: { type: "string", description: "id from project_list" },
          ...(schema.properties ?? {}),
        };
        schema.required = ["project_id", ...(schema.required ?? [])];
      }
      delete schema.$schema;
      return {
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: schema,
        annotations: {
          title: t.title,
          readOnlyHint: t.effects === "read",
          destructiveHint: t.effects === "destructive",
          idempotentHint: t.effects === "read",
          openWorldHint: false,
        },
      };
    });
  }

  private async callTool(name: string, args: any) {
    const t = this.deps.registry.get(name);
    if (!t) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    const { project_id, ...input } = args ?? {};
    let project: ToolContext["project"];
    if (t.project) {
      if (!project_id)
        return { content: [{ type: "text", text: `${name} needs project_id (see project_list)` }], isError: true };
      try {
        project = this.deps.workspace.get(project_id);
      } catch (e: any) {
        return { content: [{ type: "text", text: `${e.message}${e.fix ? `\nfix: ${e.fix}` : ""}` }], isError: true };
      }
    }
    const res = await this.deps.registry.call(name, input, {
      author: { kind: "mcp", client: this.deps.client ?? "mcp" },
      project,
      workspace: this.deps.workspace,
      emit: (e) => project?.emit(e.type, e),
    });
    if (!res.ok)
      return {
        content: [
          {
            type: "text",
            text: `${res.error.code}: ${res.error.message}${res.error.fix ? `\nfix: ${res.error.fix}` : ""}`,
          },
        ],
        isError: true,
      };
    const content: any[] = [{ type: "text", text: JSON.stringify(res.data, null, 1) }];
    for (const img of res.images ?? [])
      content.push({ type: "image", data: Buffer.from(img.data).toString("base64"), mimeType: img.mediaType });
    const structured =
      res.data && typeof res.data === "object" && !Array.isArray(res.data) ? res.data : { result: res.data };
    return { content, structuredContent: structured };
  }

  private resources() {
    const docs = existsSync(DOCS_DIR) ? readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")) : [];
    return [
      { uri: "pap://projects", name: "projects", title: "Projects", mimeType: "application/json" },
      {
        uri: "pap://schema/project",
        name: "project-schema",
        title: "Project document JSON Schema",
        mimeType: "application/json",
      },
      ...docs.map((f) => ({
        uri: `pap://docs/${f}`,
        name: f,
        title: f.replace(/\.md$/, ""),
        mimeType: "text/markdown",
      })),
      ...this.deps.workspace.list().map((p) => ({
        uri: `pap://p/${p.id}/doc`,
        name: `${p.id}-doc`,
        title: `${p.title}: document`,
        mimeType: "application/json",
      })),
    ];
  }

  private readResource(uri: string) {
    const text = (s: string, mimeType = "application/json") => ({ contents: [{ uri, mimeType, text: s }] });
    if (uri === "pap://projects") return text(JSON.stringify(this.deps.workspace.list(), null, 1));
    if (uri === "pap://schema/project")
      return text(JSON.stringify(z.toJSONSchema(Project, { io: "input", unrepresentable: "any" }), null, 1));
    let m = /^pap:\/\/docs\/([A-Za-z0-9_.-]+\.md)$/.exec(uri);
    if (m && existsSync(join(DOCS_DIR, m[1]))) return text(readFileSync(join(DOCS_DIR, m[1]), "utf8"), "text/markdown");
    m = /^pap:\/\/skills\/([a-z0-9-]+)$/.exec(uri);
    if (m && existsSync(join(SKILLS_DIR, m[1], "SKILL.md")))
      return text(readFileSync(join(SKILLS_DIR, m[1], "SKILL.md"), "utf8"), "text/markdown");
    m = /^pap:\/\/p\/([a-z0-9_]+)\/doc$/.exec(uri);
    if (m) return text(JSON.stringify(this.deps.workspace.get(m[1]).doc(), null, 1));
    m = /^pap:\/\/p\/([a-z0-9_]+)\/(questions|ledger)$/.exec(uri);
    if (m) {
      const p = this.deps.workspace.get(m[1]);
      return text(JSON.stringify(m[2] === "questions" ? p.state.questions : p.state.tasks, null, 1));
    }
    return null;
  }

  async handle(msg: Rpc): Promise<RpcOut | null> {
    const id = msg.id ?? null;
    const reply = (result: unknown): RpcOut => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string, data?: unknown): RpcOut => ({
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    });
    const isNote = msg.id === undefined;
    try {
      switch (msg.method) {
        case "initialize": {
          const want = msg.params?.protocolVersion;
          this.protocol = MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0];
          this.deps.client = msg.params?.clientInfo?.name ?? this.deps.client;
          return reply({
            protocolVersion: this.protocol,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false, subscribe: false },
              prompts: { listChanged: false },
            },
            serverInfo: { name: "pixelartpitch", title: "PixelArtPitch", version: this.deps.version },
            instructions:
              "PixelArtPitch makes short pixel-art pitch videos. Start with project_list or project_create. Project tools need project_id. Read pap://docs/STYLE-GUIDE.md and pap://docs/RECIPES.md before building scenes. Tools return errors with a `fix` line: apply it and retry.",
          });
        }
        case "notifications/initialized":
          this.initialized = true;
          return null;
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: this.toolList() });
        case "tools/call":
          return reply(await this.callTool(msg.params?.name, msg.params?.arguments));
        case "resources/list":
          return reply({ resources: this.resources() });
        case "resources/templates/list":
          return reply({
            resourceTemplates: [
              {
                uriTemplate: "pap://p/{project_id}/doc",
                name: "project-doc",
                title: "A project's document",
                mimeType: "application/json",
              },
              {
                uriTemplate: "pap://p/{project_id}/questions",
                name: "project-questions",
                title: "A project's questions",
                mimeType: "application/json",
              },
              {
                uriTemplate: "pap://docs/{file}",
                name: "docs",
                title: "PixelArtPitch guides",
                mimeType: "text/markdown",
              },
              {
                uriTemplate: "pap://skills/{role}",
                name: "skills",
                title: "A crew role's skill",
                mimeType: "text/markdown",
              },
            ],
          });
        case "resources/read": {
          const r = this.readResource(msg.params?.uri);
          return r ? reply(r) : err(-32002, `resource not found: ${msg.params?.uri}`);
        }
        case "prompts/list":
          return reply({ prompts: PROMPTS.map(({ text: _t, ...p }) => p) });
        case "prompts/get": {
          const p = PROMPTS.find((x) => x.name === msg.params?.name);
          if (!p) return err(-32602, `unknown prompt ${msg.params?.name}`);
          return reply({
            description: p.description,
            messages: [{ role: "user", content: { type: "text", text: p.text(msg.params?.arguments ?? {}) } }],
          });
        }
        default:
          return isNote ? null : err(-32601, `method not found: ${msg.method}`);
      }
    } catch (e: any) {
      return isNote ? null : err(-32603, String(e?.message ?? e));
    }
  }
}

/** stdio transport: newline-delimited JSON-RPC on stdin/stdout; logs go to stderr */
export function serveStdio(deps: McpDeps) {
  const s = new McpSession(deps);
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
        );
        continue;
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      for (const m of batch) {
        const out = await s.handle(m);
        if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
      }
    }
  });
}
