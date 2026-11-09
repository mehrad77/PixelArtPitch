// Render the promo: steps compose.html frame by frame in headless Chrome (over the DevTools Protocol, no npm
// dependencies), pipes the frames into ffmpeg, and muxes the mix in.
//
//   node scripts/promo/compose.mjs --work <dir> --out <mp4> [--w 1920 --h 1080] [--format wide|tall]
//                                  [--from 0 --to 92] [--fps 30] [--audio <wav>] [--still <t> (one PNG)]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    work: { type: "string" },
    out: { type: "string" },
    w: { type: "string", default: "1920" },
    h: { type: "string", default: "1080" },
    format: { type: "string", default: "wide" },
    from: { type: "string", default: "0" },
    to: { type: "string" },
    fps: { type: "string", default: "30" },
    audio: { type: "string" },
    still: { type: "string" },
    crf: { type: "string", default: "16" },
    thumb: { type: "boolean", default: false },
    cut: { type: "string", default: "" },
  },
});
if (!o.work || !o.out) throw new Error("usage: compose.mjs --work <dir> --out <file>");
const W = Number(o.w);
const H = Number(o.h);
const FPS = Number(o.fps);
const timing = JSON.parse(readFileSync(new URL("./timing.json", import.meta.url), "utf8"));
const FROM = Number(o.from);
const TO = Number(o.to ?? timing.duration);
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---- Chrome over CDP ----
const profile = mkdtempSync(join(tmpdir(), "pap-promo-chrome-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--allow-file-access-from-files",
    "--disable-web-security",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--disable-gpu-vsync",
    `--window-size=${W},${H}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on("exit", cleanup);

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((x) => x.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome did not start");
}
const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(`${m.error.message}`)) : res(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const work = pathToFileURL(resolve(o.work)).href;
const page = pathToFileURL(resolve(new URL(".", import.meta.url).pathname, "compose.html")).href;
await send("Page.navigate", {
  url: `${page}?work=${encodeURIComponent(work)}&w=${W}&h=${H}&format=${o.format}${o.thumb ? "&thumb=1" : ""}${o.cut ? `&cut=${o.cut}` : ""}`,
});
for (let i = 0; i < 100; i++) {
  try {
    if (await evaluate("window.promoReady")) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const shot = async (t) => {
  await evaluate(`window.renderFrame(${t})`);
  const { data } = await send("Page.captureScreenshot", {
    format: o.still ? "png" : "jpeg",
    quality: o.still ? undefined : 95,
  });
  return Buffer.from(data, "base64");
};

if (o.still) {
  writeFileSync(o.out, await shot(Number(o.still)));
  console.log(o.out);
  cleanup();
  process.exit(0);
}

// ---- frames into ffmpeg ----
const audio = o.audio && existsSync(o.audio) ? o.audio : null;
const ff = spawn(
  "ffmpeg",
  [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(FPS),
    "-c:v",
    "mjpeg",
    "-i",
    "-",
    ...(audio ? ["-ss", String(FROM), "-t", String(TO - FROM), "-i", audio] : []),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    o.crf,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    ...(audio ? ["-c:a", "aac", "-b:a", "256k", "-shortest"] : []),
    o.out,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const total = Math.round((TO - FROM) * FPS);
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  const buf = await shot(FROM + i / FPS);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 60 === 0) process.stdout.write(`\r${i}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`\n${o.out}`);
cleanup();
process.exit(0);
