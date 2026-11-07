import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { McpClient, resultText } from "../src/index.ts";

const FAKE = new URL("./fixtures/fake-server.mjs", import.meta.url).pathname;

test("stdio: initialize, paginated tools/list, tools/call, list_changed, minimal env", async () => {
  let changed = 0;
  const c = new McpClient(
    { type: "stdio", command: process.execPath, args: [FAKE], env: { SECRET_TOKEN: "abc" } },
    { onToolsChanged: () => changed++ },
  );
  await c.connect();
  assert.equal(c.serverInfo.name, "fake");
  const tools = await c.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["search", "env", "write"],
  );
  assert.equal(tools[0].annotations?.readOnlyHint, true);
  const r = await c.callTool("search", { q: "rain" });
  assert.match(resultText(r).text, /found: rain/);
  const env = resultText(await c.callTool("env", {})).text.split(",");
  // PATH, HOME and the declared env only (the runtime may add a few of its own, never the parent's other vars)
  assert.ok(env.includes("SECRET_TOKEN") && env.includes("PATH"));
  assert.ok(!env.includes("PAP_HOME") && !env.includes("USER") && !env.includes("SHELL"), env.join(","));
  await c.callTool("write", { v: "x" });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(changed, 1);
  const long = resultText(await c.callTool("search", { q: "a", pad: 9000 }), 1000).text;
  assert.match(long, /truncated/);
  c.close();
});

test("stdio: a missing command fails with a fix", async () => {
  const c = new McpClient({ type: "stdio", command: "pap-no-such-command-xyz" }, { connectTimeoutMs: 3000 });
  await assert.rejects(c.connect(), (e: any) => e.code === "not_found" && /full path/.test(e.fix));
});

test("http: JSON and SSE answers, session id, 401 has a fix", async () => {
  let sessions = 0;
  const srv = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    let body = "";
    for await (const ch of req) body += ch;
    if (req.headers.authorization !== "Bearer good") {
      res.writeHead(401).end();
      return;
    }
    const m = JSON.parse(body);
    if (m.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (m.method === "initialize") {
      sessions++;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "h" }, capabilities: {} } }));
      return;
    }
    assert.equal(req.headers["mcp-session-id"], "s1");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const result =
      m.method === "tools/list"
        ? { tools: [{ name: "t", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "sse ok" }] };
    res.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`,
    );
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/mcp`;
  try {
    const c = new McpClient({ type: "http", url, headers: { authorization: "Bearer good" } });
    await c.connect();
    assert.equal(sessions, 1);
    assert.deepEqual(
      (await c.listTools()).map((t) => t.name),
      ["t"],
    );
    assert.equal(resultText(await c.callTool("t", {})).text, "sse ok");
    c.close();
    const bad = new McpClient({ type: "http", url, headers: { authorization: "Bearer nope" } });
    await assert.rejects(bad.connect(), (e: any) => e.code === "unauthorized" && /Authorization/.test(e.fix));
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
