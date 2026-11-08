#!/usr/bin/env node
// pap serve [--port 5141] [--dev] [--build]
//                                        the studio (UI + API + MCP over HTTP); prints the launch URL. Warns when
//                                        the web build is older than apps/web/src; --build rebuilds it first
// pap mcp                                MCP over stdio (proxies to a running `pap serve`, or runs in-process)
// pap render <project> [--delivery id]   export a video
// pap still <project> <t> [--scale 4]    one PNG to stdout's path
// pap golden <project>                   check frames against <project>/gen/golden.json
// pap report <project> [--run <id>|--all] [--notes findings.md] [--picks picks.jsonl] [--out <dir>] [--include-private]
//                                        the run as one HTML page (docs/REPORT.md)
// pap library promote <id> [--from <user-library>] [--to <seed>]
//                                        copy an asset from your library into the repo's public library/
//                                        (the standard and the rights checks; docs/RIGHTS.md §5)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { checkGolden, loadProject, openRenderer, promoteAsset, userLibraryDir } from "@pap/render";
import { buildReport } from "@pap/report";
import { buildRegistry, PAP_HOME, Workspace } from "@pap/tools";
import { createApp, VERSION } from "./app.ts";
import { webBuild } from "./build.ts";
import { serveStdio } from "./mcp.ts";
import { wireCrew } from "./wire.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = rest.indexOf(`--${n}`);
  return i < 0 ? d : rest[i + 1];
};
const SERVER_FILE = join(PAP_HOME, "server.json");

function roots(): string[] {
  const f = join(PAP_HOME, "settings.json");
  try {
    const s = JSON.parse(readFileSync(f, "utf8"));
    if (Array.isArray(s?.paths?.roots) && s.paths.roots.length) return s.paths.roots;
  } catch {}
  return [join(PAP_HOME, "projects")];
}

function running(): { port: number; pid: number; token: string; mcpToken: string } | null {
  if (!existsSync(SERVER_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(SERVER_FILE, "utf8"));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
}

async function main() {
  if (cmd === "serve") {
    const port = Number(flag("port", "5141"));
    const web = new URL("../../web/", import.meta.url).pathname;
    if (rest.includes("--build")) {
      console.log("Building the studio UI…");
      const b = spawnSync("pnpm", ["--filter", "@pap/web", "build"], { cwd: join(web, "../.."), stdio: "inherit" });
      if (b.status !== 0) {
        console.error("The studio UI didn't build; see the output above.");
        process.exit(1);
      }
    }
    const build = webBuild(web);
    if (build.webStale)
      console.warn(
        `Warning: the studio UI build (${build.builtAt ?? "missing"}) is older than apps/web/src (${build.srcAt}). Run \`pap serve --build\`, or \`pnpm --filter @pap/web build\`.`,
      );
    mkdirSync(PAP_HOME, { recursive: true });
    const workspace = new Workspace(roots);
    const registry = buildRegistry();
    const wired = await wireCrew({ workspace, registry });
    // keep the tokens across restarts so an open studio tab and MCP clients stay signed in
    const AUTH = join(PAP_HOME, "auth.json");
    let saved: { token?: string; mcpToken?: string } = {};
    try {
      saved = JSON.parse(readFileSync(AUTH, "utf8"));
    } catch {}
    const { app, token, mcpToken } = createApp({
      port,
      workspace,
      registry,
      dev: rest.includes("--dev"),
      token: saved.token,
      mcpToken: saved.mcpToken,
      ...wired,
    });
    writeFileSync(AUTH, JSON.stringify({ token, mcpToken }));
    chmodSync(AUTH, 0o600);
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    writeFileSync(SERVER_FILE, JSON.stringify({ port, pid: process.pid, token, mcpToken, version: VERSION }));
    chmodSync(SERVER_FILE, 0o600);
    const url = `http://127.0.0.1:${port}/?t=${token}`;
    console.log(
      `PixelArtPitch ${VERSION} on http://127.0.0.1:${port}\nopen: ${url}\nMCP:  http://127.0.0.1:${port}/mcp  (Authorization: Bearer <mcpToken in ${SERVER_FILE}>)`,
    );
    const stop = () => {
      wired.connections.closeAll();
      workspace.closeAll();
      rmSync(SERVER_FILE, { force: true });
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (cmd === "mcp") {
    const s = running();
    if (s) {
      // one writer per project: forward stdio JSON-RPC to the running server
      let session = "";
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
          const r = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${s.mcpToken}`,
              host: `127.0.0.1:${s.port}`,
              ...(session ? { "mcp-session-id": session } : {}),
            },
            body: line,
          });
          session = r.headers.get("mcp-session-id") ?? session;
          if (r.status === 202) continue;
          process.stdout.write(`${(await r.text()).trim()}\n`);
        }
      });
      return;
    }
    const workspace = new Workspace(roots);
    const registry = buildRegistry();
    await wireCrew({ workspace, registry });
    serveStdio({ registry, workspace, version: VERSION });
    process.on("exit", () => workspace.closeAll());
    return;
  }
  if (cmd === "golden") {
    const dir = resolve(rest[0]);
    const p = loadProject(dir);
    const r = await openRenderer(p);
    const res = await checkGolden(r, JSON.parse(readFileSync(join(dir, "gen", "golden.json"), "utf8")));
    r.close();
    console.log(
      res.ok
        ? `golden: ok (${res.frames} frames)`
        : `golden: ${res.mismatches} frames differ, first: ${res.bad.join(", ")}`,
    );
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === "report") {
    // by path or by id, without taking the project's lock: a running studio keeps writing while this reads
    const arg = rest[0];
    if (!arg || arg.startsWith("--")) {
      console.error(
        "usage: pap report <project> [--run <id>|--all] [--notes findings.md] [--picks picks.jsonl] [--out <dir>] [--include-private]",
      );
      process.exit(1);
    }
    const byPath = existsSync(join(resolve(arg), "pitch.json")) ? resolve(arg) : null;
    const known = byPath ? [] : new Workspace(roots).list();
    const dir = byPath ?? known.find((p) => p.id === arg)?.dir;
    if (!dir) {
      const ids = known.map((p) => p.id).join(", ") || "(none)";
      console.error(`not_found: no project ${arg}\nfix: pass a project folder or one of: ${ids}`);
      process.exit(1);
    }
    const notes = flag("notes");
    const picks = flag("picks");
    const out = resolve(flag("out") ?? join(dir, "out", "report"));
    try {
      const r = buildReport(dir, {
        run: rest.includes("--all") ? undefined : flag("run"),
        notes: notes && resolve(notes),
        picks: picks && resolve(picks),
        includePrivate: rest.includes("--include-private"),
        ledger: join(PAP_HOME, "ledger.sqlite"),
        out,
      });
      const { ncalls, total } = r.summary;
      console.log(`${join(out, "index.html")}  (${r.images.length} images, ${ncalls} calls, $${total.toFixed(2)})`);
      process.exit(0);
    } catch (e: any) {
      console.error(`report: ${e?.message ?? e}${e?.fix ? `\nfix: ${e.fix}` : ""}`);
      process.exit(1);
    }
  }
  if (cmd === "library") {
    const [sub, id] = rest;
    if (sub !== "promote" || !id || id.startsWith("--")) {
      console.error("usage: pap library promote <id> [--from <user-library>] [--to <seed>]");
      process.exit(1);
    }
    const from = resolve(flag("from") ?? userLibraryDir());
    const r = promoteAsset(id, { from, ...(flag("to") ? { to: resolve(flag("to")!) } : {}) });
    if (!r.ok) {
      console.error(`refused: ${id} stays in ${from}\n${r.reasons.map((x) => `- ${x}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`${r.dir}${r.soft.length ? `\nfor a vision check: ${r.soft.slice(0, 3).join("; ")}` : ""}`);
    process.exit(0);
  }
  if (cmd === "still" || cmd === "render") {
    const workspace = new Workspace(() => []);
    const p = workspace.openDir(resolve(rest[0]));
    const registry = buildRegistry();
    const ctx = { author: { kind: "user" as const }, project: p, workspace, emit: () => {} };
    const res =
      cmd === "still"
        ? await registry.call("render_still", { t: Number(rest[1] ?? 0), scale: Number(flag("scale", "4")) }, ctx)
        : await registry.call("export_video", { delivery: flag("delivery") }, ctx);
    if (!res.ok) {
      console.error(`${res.error.code}: ${res.error.message}${res.error.fix ? `\nfix: ${res.error.fix}` : ""}`);
      workspace.closeAll();
      process.exit(1);
    }
    if (cmd === "still" && res.images?.[0]) {
      const out = join(p.dir, "out", `still-${rest[1] ?? 0}.png`);
      writeFileSync(out, res.images[0].data);
      console.log(out);
    } else console.log(JSON.stringify(res.data, null, 1));
    workspace.closeAll();
    process.exit(0);
  }
  console.log(
    "usage: pap serve [--port 5141] | mcp | render <dir> [--delivery id] | still <dir> <t> | golden <dir> | report <project> | library promote <id>",
  );
  process.exit(cmd ? 1 : 0);
}
main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
