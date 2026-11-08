// The end-to-end driver (scripts/e2e/README.md): a throwaway PAP_HOME, the web app built first, a real studio you
// watch and drive in the browser, a total-spend watchdog and a log of the workspace events. It never reads, prints or
// stores an API key: the studio reads keys the way it always does.
//
//   node scripts/e2e/driver.ts --home /tmp/pap-e2e [--port 5199] [--cap 8] [--copy <project dir>]...
//
// A first start sets the home up (settings from ~/.pixelartpitch/settings.json, with the run's roles; an empty user
// library; no connections; each --copy project copied in without its lock). A restart with the same home keeps its
// ledger and projects. Logs go to <home>/e2e/.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));
const HOME_ARG = opt("home", process.env.PAP_E2E_HOME);
if (!HOME_ARG) {
  console.error("usage: node scripts/e2e/driver.ts --home <throwaway PAP_HOME> [--port 5199] [--cap 8] [--copy <dir>]");
  process.exit(2);
}
const HOME = resolve(HOME_ARG);
if (HOME === resolve(homedir(), ".pixelartpitch")) {
  console.error("--home must be a throwaway folder, not your real ~/.pixelartpitch");
  process.exit(2);
}
const REPO = new URL("../../", import.meta.url).pathname;
const PORT = Number(opt("port", "5199"));
/** the watchdog: the whole run's spend (every project in this home), in dollars */
const TOTAL_CAP = Number(opt("cap", process.env.PAP_E2E_CAP ?? "8"));
const OUT = join(HOME, "e2e");
mkdirSync(OUT, { recursive: true });
const log = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  appendFileSync(join(OUT, "driver.log"), `${line}\n`);
};

// the web app first, so the page is the code under test (pap serve warns when it is stale)
log("building the studio UI");
const b = spawnSync("pnpm", ["--filter", "@pap/web", "build"], { cwd: REPO, stdio: "inherit" });
if (b.status !== 0) {
  log("the studio UI didn't build");
  process.exit(1);
}

if (!existsSync(join(HOME, "settings.json"))) {
  mkdirSync(join(HOME, "projects"), { recursive: true });
  // settings: your file's providers and prices (keys aren't in it), the run's roles; a public-only library
  const mine = join(homedir(), ".pixelartpitch", "settings.json");
  const s = existsSync(mine) ? JSON.parse(readFileSync(mine, "utf8")) : {};
  const OPUS = "anthropic/claude-opus-5-5";
  const SONNET = "anthropic/claude-sonnet-5-5";
  const HAIKU = "anthropic/claude-haiku-5-5";
  const roles: Record<string, { model: string; fallback?: string }> = {};
  for (const r of ["producer", "editor", "mixer", "sound-designer", "librarian"])
    roles[r] = { model: HAIKU, fallback: SONNET };
  for (const r of ["writer", "director", "art-director", "animator", "reviewer", "scene-coder", "assistant"])
    roles[r] = { model: SONNET, fallback: HAIKU };
  roles["pixel-artist"] = { model: OPUS, fallback: SONNET };
  s.roles = roles;
  s.defaults = { ...s.defaults, capUsd: 6, involvement: "key", concurrency: 2, pipPlan: "shadow", reviewRounds: 1 };
  mkdirSync(join(HOME, "library"), { recursive: true });
  s.paths = { ...s.paths, roots: [join(HOME, "projects")], library: join(HOME, "library") };
  s.connections = [];
  writeFileSync(join(HOME, "settings.json"), JSON.stringify(s, null, 1));
  for (const dir of all("copy"))
    cpSync(resolve(dir), join(HOME, "projects", basename(resolve(dir))), {
      recursive: true,
      filter: (f) => !f.endsWith(".pap-lock"),
    });
  log(`home set up in ${HOME}`);
}

// the studio
rmSync(join(HOME, "server.json"), { force: true });
const srv = spawn(process.execPath, [join(REPO, "apps/server/src/cli.ts"), "serve", "--port", String(PORT)], {
  cwd: REPO,
  env: { ...process.env, PAP_HOME: HOME },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => appendFileSync(join(OUT, "server.log"), d));
srv.stderr.on("data", (d) => appendFileSync(join(OUT, "server.log"), d));
srv.on("exit", (c) => {
  log(`SERVER EXITED ${c}`);
  process.exit(1);
});
for (let i = 0; i < 100 && !existsSync(join(HOME, "server.json")); i++) await new Promise((r) => setTimeout(r, 200));
const { token } = JSON.parse(readFileSync(join(HOME, "server.json"), "utf8"));
writeFileSync(join(OUT, "url.txt"), `http://127.0.0.1:${PORT}/?t=${token}\n`);
log(`READY http://127.0.0.1:${PORT} (the sign-in link is in ${join(OUT, "url.txt")})`);

// the watchdog: the whole run's spend, read from the throwaway ledger; past the cap the studio stops
let lastShown = -1;
setInterval(() => {
  if (!existsSync(join(HOME, "ledger.sqlite"))) return;
  let total = 0;
  try {
    const d = new DatabaseSync(join(HOME, "ledger.sqlite"), { readOnly: true });
    total = (d.prepare("SELECT COALESCE(SUM(usd),0) AS t FROM calls").get() as { t: number }).t;
    d.close();
  } catch {
    return;
  }
  writeFileSync(join(OUT, "spent.txt"), total.toFixed(4));
  if (Math.floor(total * 4) !== lastShown) {
    lastShown = Math.floor(total * 4);
    log(`SPENT $${total.toFixed(3)}`);
  }
  if (total > TOTAL_CAP) {
    log(`CAP: total $${total.toFixed(3)} passed $${TOTAL_CAP}; stopping the studio`);
    srv.kill("SIGTERM");
  }
}, 1000);

// the workspace stream (Pip, drafts, the line), timestamped
const H = { host: `127.0.0.1:${PORT}`, "x-pap-token": token, origin: `http://127.0.0.1:${PORT}` };
async function tail(path: string, file: string) {
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: H });
      const rd = r.body!.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (let k = buf.indexOf("\n\n"); k >= 0; k = buf.indexOf("\n\n")) {
          const chunk = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const ev = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (ev && ev !== "ping") appendFileSync(join(OUT, file), `${JSON.stringify({ at: Date.now(), ev, data })}\n`);
          if (ev === "pip" && data && /"card"/.test(data)) log(`PIP CARD ${data.slice(0, 160)}`);
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
}
void tail("/api/events", "workspace-events.jsonl");
await new Promise(() => {});
