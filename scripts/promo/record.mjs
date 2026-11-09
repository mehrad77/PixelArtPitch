// Record a real studio page for the promo: one headless Chrome stays on the page and screenshots it continuously
// (JPEG, 3840×2160 from a 1440×810 viewport, so the UI reads at video size), while commands appended to a file drive
// it: type into Pip, click, switch the view or tab, scroll, change the frame rate, stop. Plain Node 24, no
// dependencies. It does real things: only point it at a project you mean to work on.
//
//   node scripts/promo/record.mjs --url <url> --out <dir> [--fps 2] [--cmds <file>] [--w 1440 --h 810]
//
// Commands (one JSON object per line, appended while it runs):
//   {"do":"type","sel":"main .pip-input","text":"…","cps":18}   {"do":"key","key":"Enter"}
//   {"do":"click","sel":"button","label":"Start"}   {"do":"view","v":"studio"}   {"do":"goto","url":"…"}
//   {"do":"scroll","sel":".pip-card"}   {"do":"fps","n":10}   {"do":"mark","name":"start"}   {"do":"stop"}
//   {"do":"js","code":"…"} (logs the result)   {"do":"wait","s":2}
// Output: <out>/00000.jpg…, frames.jsonl ({ i, t, mark? }: t in seconds since the start).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    url: { type: "string" },
    out: { type: "string" },
    fps: { type: "string", default: "2" },
    cmds: { type: "string" },
    w: { type: "string", default: "1440" },
    h: { type: "string", default: "810" },
  },
});
const W = Number(o.w);
const H = Number(o.h);
const DPR = 3840 / W;
mkdirSync(o.out, { recursive: true });
const cmdFile = o.cmds ?? join(o.out, "cmds.jsonl");
if (!existsSync(cmdFile)) writeFileSync(cmdFile, "");
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "pap-record-"));
const port = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${W},${H}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const bye = () => {
  try {
    chrome.kill();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on("exit", bye);

// the browser's own socket: a tab made with Target.createTarget paints like a visible one (new headless's first
// page does not, once the app starts changing routes)
let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
let session;
const send = (method, params = {}, sid = session) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
{
  const { browserContextId } = await send("Target.createBrowserContext", {}, null);
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId }, null);
  session = (await send("Target.attachToTarget", { targetId, flatten: true }, null)).sessionId;
}
const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Page.bringToFront");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.navigate", { url: o.url });

// ---- commands ----
const q = (s) => JSON.stringify(s);
const find = (sel, label) =>
  `[...document.querySelectorAll(${q(sel)})].find((e) => ${label ? `(e.innerText || e.textContent || e.getAttribute("aria-label") || "").includes(${q(label)})` : "true"})`;
async function run(c) {
  if (c.do === "goto") await send("Page.navigate", { url: c.url });
  if (c.do === "click")
    await ev(
      `(() => { const e = ${find(c.sel, c.label)}; if (e) { e.scrollIntoView({ block: "center" }); e.click(); return true; } return false; })()`,
    );
  if (c.do === "scroll")
    console.log(
      `scroll ${c.sel}: ${await ev(`(() => { const e = ${find(c.sel, c.label)}; if (!e) return "not found"; e.scrollIntoView({ block: ${q(c.block ?? "center")}, behavior: ${q(c.smooth === false ? "instant" : "smooth")} }); return "ok"; })()`)}`,
    );
  if (c.do === "js") console.log(`js: ${JSON.stringify(await ev(c.code))}`);
  if (c.do === "wait") await new Promise((r) => setTimeout(r, (c.s ?? 1) * 1000));
  if (c.do === "view") {
    const label = c.v === "studio" ? "Studio" : "Simple";
    await ev(
      `(() => { const l = [...document.querySelectorAll(".mode-switch label")].find((e) => e.textContent.includes(${q(label)})); l?.click(); })()`,
    );
  }
  if (c.do === "tab")
    await ev(`(() => { const e = ${find(".tab-list [role=tab], .tab-list button", c.label)}; e?.click(); })()`);
  if (c.do === "key") {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: c.key,
      code: c.key,
      windowsVirtualKeyCode: c.key === "Enter" ? 13 : 0,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: c.key,
      code: c.key,
      windowsVirtualKeyCode: c.key === "Enter" ? 13 : 0,
    });
  }
  if (c.do === "type") {
    await ev(`(() => { const e = ${find(c.sel)}; e?.focus(); e?.click(); })()`);
    for (const ch of c.text) {
      await send("Input.insertText", { text: ch });
      await new Promise((r) => setTimeout(r, 1000 / (c.cps ?? 18)));
    }
  }
  if (c.do === "fps") fps = Number(c.n);
  if (c.do === "mark") mark = c.name;
  if (c.do === "stop") stop = true;
}
let fps = Number(o.fps);
let mark = null;
let stop = false;
let done = 0;
let busy = Promise.resolve();
setInterval(() => {
  const lines = readFileSync(cmdFile, "utf8").split("\n").filter(Boolean);
  for (; done < lines.length; done++) {
    const c = JSON.parse(lines[done]);
    busy = busy.then(() => run(c)).catch((e) => console.error(`command ${lines[done]}: ${e.message}`));
  }
}, 200);

// ---- frames ----
const t0 = Date.now();
let i = 0;
while (!stop) {
  const at = Date.now();
  try {
    // a frame painted now, not the last one the compositor kept (an in-app route change can leave it stale)
    await Promise.race([
      ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    writeFileSync(join(o.out, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(data, "base64"));
    appendFileSync(
      join(o.out, "frames.jsonl"),
      `${JSON.stringify({ i, t: (at - t0) / 1000, ...(mark ? { mark } : {}) })}\n`,
    );
    mark = null;
    i++;
  } catch (e) {
    console.error(`frame: ${e.message}`);
  }
  const wait = 1000 / fps - (Date.now() - at);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
await busy;
console.log(`${i} frames in ${o.out}`);
bye();
process.exit(0);
