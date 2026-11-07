// Reads pasted MCP server JSON (the `mcpServers` shape Claude Desktop and Claude Code use) for the preview on the
// "Add connection" form. A convenience only: the server parses it again and is the one that decides.
export type ParsedServer = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  host?: string;
  envKeys: string[];
  headerKeys: string[];
  problem?: string;
};
export type Parsed = { servers: ParsedServer[]; error?: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function lineOf(text: string, msg: string): string {
  const pos = Number(msg.match(/position (\d+)/)?.[1]);
  if (!Number.isFinite(pos)) return "";
  return ` (line ${text.slice(0, pos).split("\n").length})`;
}

export function parseMcpJson(raw: string): Parsed {
  const text = raw.trim();
  if (!text) return { servers: [] };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    // a fragment copied from inside mcpServers: "name": { … }
    try {
      v = JSON.parse(`{${text}}`);
    } catch {
      const msg = (e as Error).message;
      return {
        servers: [],
        error: `This isn't valid JSON${lineOf(text, msg)}. Check for a missing comma or quote, or paste the whole block.`,
      };
    }
  }
  if (!isObj(v)) return { servers: [], error: 'Paste an object: { "mcpServers": { … } }.' };
  let map: Record<string, unknown> = isObj(v.mcpServers) ? v.mcpServers : isObj(v.servers) ? v.servers : v;
  // one server on its own, without a name
  if (typeof map.command === "string" || typeof map.url === "string") map = { server: map };
  const servers: ParsedServer[] = [];
  for (const [name, def] of Object.entries(map)) {
    if (!isObj(def)) {
      servers.push({ name, transport: "stdio", args: [], envKeys: [], headerKeys: [], problem: "Not a server entry." });
      continue;
    }
    const envKeys = isObj(def.env) ? Object.keys(def.env) : [];
    const headerKeys = isObj(def.headers) ? Object.keys(def.headers) : [];
    const args = Array.isArray(def.args) ? def.args.map(String) : [];
    if (typeof def.url === "string") {
      let host = def.url;
      try {
        host = new URL(def.url).host;
      } catch {
        servers.push({
          name,
          transport: "http",
          url: def.url,
          args,
          envKeys,
          headerKeys,
          problem: "The url isn't a web address.",
        });
        continue;
      }
      servers.push({ name, transport: "http", url: def.url, host, args, envKeys, headerKeys });
    } else if (typeof def.command === "string" && def.command.trim()) {
      servers.push({ name, transport: "stdio", command: def.command, args, envKeys, headerKeys });
    } else
      servers.push({
        name,
        transport: "stdio",
        args,
        envKeys,
        headerKeys,
        problem: "Give it a command (to run here) or a url (to connect to).",
      });
  }
  if (!servers.length) return { servers, error: "No servers found. Paste the block that holds mcpServers." };
  return { servers };
}

export const commandLine = (s: { command?: string; args?: string[] }) =>
  [s.command ?? "", ...(s.args ?? [])].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

const list = (xs: string[]) =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : xs.length === 2
      ? `${xs[0]} and ${xs[1]}`
      : `${xs[0]}, ${xs[1]} and ${xs.length - 2} more`;

/** what pressing submit does, in parts so the commands can sit in <code> */
export function submitEffect(servers: ParsedServer[]): { run: string[]; hosts: string[] } {
  const ok = servers.filter((s) => !s.problem);
  return {
    run: ok.filter((s) => s.transport === "stdio").map(commandLine),
    hosts: ok.filter((s) => s.transport === "http").map((s) => s.host ?? s.url ?? s.name),
  };
}
export const hostsWords = list;
