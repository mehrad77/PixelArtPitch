#!/usr/bin/env node
// The promo's studio captures (scripts/promo/SHOTS.md): headless Chrome over the DevTools Protocol, a 1920×1080
// viewport at device scale 2 (3840×2160 PNGs), dark. Plain Node 24, no dependencies: Node's global WebSocket.
//
//   node scripts/promo/capture.mjs                      every shot, from the mock (?mock=1) only
//   node scripts/promo/capture.mjs shots brief,lantern  some sessions (pages, brief, run, lantern, overrun, edits, full)
//   node scripts/promo/capture.mjs still --url <url> --out <png> [--rects '<css selector>,...'] [--wait <selector>]
//        [--view simple|studio] [--reduced-motion] [--allow-pip-read] [--ms <settle ms>]
//                                                       one still of any page; prints the rects (× 2, in PNG pixels):
//                                                       every match of each selector in the viewport, [x, y, w, h]
//   node scripts/promo/capture.mjs probe --url <url> [--out <png>]   1× screenshot and the page's text, for looking
//
// Mock shots: every request under /api/ is failed in the browser (the mock never needs one), every page must show the
// header's "Mock data" badge before a frame is kept (it is then hidden with CSS), and every page's text is scanned for
// private names. Output: OUT/<id>.png or OUT/<id>/0000.png…, and OUT/index.json.
// `still` on a real page fails only writes (non-GET) and anything under /api/pip; it never scans or hides anything.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.PAP_URL ?? "http://localhost:5141";
// default: pap-promo-work/shots next to the repo, outside it (captures are never committed)
const OUT = process.env.PROMO_SHOTS ?? new URL("../../../pap-promo-work/shots", import.meta.url).pathname;
const W = 1920;
const H = 1080;
const DSF = 2;
const FPS = 30;
/** never in a kept frame (case-insensitive); `sk-` only at a word start, so "task-" doesn't trip it */
const BANNED = [/crypto/i, /gamescrobbler/i, /divan/i, /edit_test/i, /ebrahim/i, /farzad/i, /\/Users\//i, /\bsk-/i];
/** the boxes worth pushing in on, by name: every match, × DSF, in PNG pixels */
const RECTS = {
  pipCard: ".pip-card",
  briefCard: ".brief-card",
  questionCard: ".pip-card[data-type='form']",
  player: ".viewer-frame",
  crewFaces: ".crew-strip",
  pipFace: ".crew-lead",
  plan: ".pip-plan, .crew-plan, .pip-card[data-type='plan']",
  budget: ".ws-budget, .sp-money",
  versions: ".sp-version, .versions",
  timeline: ".pip-thread",
};

/** `still`'s rects when --rects is left out: Pip's card, the player and the Studio view's main panes */
const STILL_RECTS = [
  ".viewer-frame",
  ".pip-card",
  ".crew-strip",
  ".ws-header",
  ".stage-nav",
  ".ws-main",
  ".viewer",
  ".ws-right",
  ".stage-panel",
  ".tracks",
];

// ---------------------------------------------------------------- the protocol

class CDP {
  #id = 0;
  #pending = new Map();
  #handlers = new Set();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id != null) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} ${msg.error.data ?? ""}`));
        else p.resolve(msg.result);
      } else for (const h of this.#handlers) h(msg);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`Can't connect to ${url}`)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    const id = ++this.#id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }
  on(fn) {
    this.#handlers.add(fn);
    return () => this.#handlers.delete(fn);
  }
  /** the next event `method` on `sessionId` that passes `pred` */
  once(method, sessionId, pred = () => true, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => (off(), reject(new Error(`no ${method} in ${timeoutMs} ms`))), timeoutMs);
      const off = this.on((m) => {
        if (m.method === method && m.sessionId === sessionId && pred(m.params)) {
          clearTimeout(t);
          off();
          resolve(m.params);
        }
      });
    });
  }
}

async function launchChrome() {
  const dir = mkdtempSync(join(tmpdir(), "pap-promo-chrome-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  let lines = [];
  for (let i = 0; i < 40; i++) {
    lines = readFileSync(portFile, "utf8").trim().split("\n");
    if (lines.length >= 2) break;
    await sleep(50);
  }
  const cdp = await CDP.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  const close = async () => {
    try {
      await cdp.send("Browser.close", {}, undefined, 5000);
    } catch {}
    proc.kill();
    await sleep(200);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { cdp, close };
}

// ---------------------------------------------------------------- one tab, in its own browser context

class Tab {
  /** every /api/ request the page tried (all failed in mock mode) */
  blocked = [];
  /** origins other than BASE the page asked for */
  external = new Set();
  constructor(cdp, sessionId, contextId, mode) {
    Object.assign(this, { cdp, sessionId, contextId, mode });
  }
  /** opts: reducedMotion (prefers-reduced-motion: reduce), allowPipRead (real pages: let GET /api/pip itself through) */
  static async open(cdp, mode = "mock", opts = {}) {
    const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, browserContextId, mode);
    tab.targetId = targetId;
    tab.opts = opts;
    const s = (m, p) => cdp.send(m, p, sessionId);
    await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Network.enable")]);
    await s("Emulation.setFocusEmulationEnabled", { enabled: true });
    await s("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false });
    await s("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: opts.reducedMotion ? "reduce" : "no-preference" },
      ],
    });
    // the guard: in mock mode nothing reaches /api/ at all; on a real page (still) no write and no Pip turn
    await s("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    tab.off = cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Fetch.requestPaused") tab.#route(m.params);
      if (m.method === "Runtime.exceptionThrown")
        console.warn(`  page error: ${m.params.exceptionDetails?.exception?.description?.split("\n")[0]}`);
    });
    return tab;
  }
  #route({ requestId, request }) {
    const url = new URL(request.url);
    const api = url.origin === new URL(BASE).origin && url.pathname.startsWith("/api/");
    // `--allow-pip-read`: GET /api/pip itself (the conversation, read-only); never a POST, never anything below it
    const pipRead = this.opts?.allowPipRead && request.method === "GET" && url.pathname === "/api/pip";
    const block =
      this.mode === "mock"
        ? api
        : api && (request.method !== "GET" || (url.pathname.startsWith("/api/pip") && !pipRead));
    if (/^https?:$/.test(url.protocol) && url.origin !== new URL(BASE).origin) this.external.add(url.origin);
    if (block) {
      this.blocked.push(`${request.method} ${url.pathname}`);
      this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, this.sessionId).catch(() => {});
    } else this.cdp.send("Fetch.continueRequest", { requestId }, this.sessionId).catch(() => {});
  }
  send(method, params = {}, timeoutMs) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }
  async close() {
    this.off?.();
    try {
      await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
      await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId });
    } catch {}
  }

  /** a page load (wipes the mock's in-memory state: use go() inside a run) */
  async load(url) {
    const loaded = this.cdp.once("Page.loadEventFired", this.sessionId, () => true, 30_000);
    await this.send("Page.navigate", { url });
    await loaded;
    await this.eval("document.fonts.ready.then(() => true)");
    if (this.mode === "mock") await this.assertMock();
  }
  /** an in-app move: the router listens to popstate */
  async go(path) {
    await this.eval(
      `history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate")); true`,
    );
    await sleep(400);
  }
  async eval(expression, { awaitPromise = true, timeoutMs } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails)
      throw new Error(
        `eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`,
      );
    return r.result.value;
  }
  /** polls a page expression until it's truthy */
  async until(expression, timeoutMs = 20_000, label = expression) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval(`!!(${expression})`)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }
  /** an element with this selector whose text contains `text` (case-insensitive), its centre in CSS px */
  async find(selector, text = null) {
    return this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        return ${JSON.stringify(text)} == null || (e.innerText || e.getAttribute("aria-label") || e.value || "").toLowerCase().includes(${JSON.stringify((text ?? "").toLowerCase())});
      });
      const e = els[0];
      if (!e) return null;
      e.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
  }
  async waitFor(selector, text = null, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const p = await this.find(selector, text);
      if (p) return p;
      await sleep(150);
    }
    throw new Error(`no ${selector}${text ? ` with "${text}"` : ""} in ${timeoutMs} ms`);
  }
  /** a real mouse click (no keyboard, so no focus ring is drawn), then the pointer leaves for a corner */
  async click(selector, text = null, timeoutMs = 20_000) {
    const p = await this.waitFor(selector, text, timeoutMs);
    await this.mouse(p.x, p.y);
    return p;
  }
  async mouse(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W - 2, y: H - 2 });
  }
  async type(text) {
    await this.send("Input.insertText", { text });
  }
  async key(key, code = key, keyCode = 13) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  }
  async blur() {
    await this.eval("document.activeElement?.blur?.(); true");
  }

  /** a project page's "Simple | Studio" switch in the header (it remembers the choice and moves to the stage) */
  async setView(view) {
    const label = view === "studio" ? "Studio" : "Simple";
    if (await this.eval(`!!document.querySelector("#mode-${view}:checked")`)) return;
    await this.click(".mode-switch label", label);
    await this.until(`document.querySelector("#mode-${view}:checked")`, 10_000, `the ${label} view`);
    await sleep(800);
  }
  /** the mock's own mark must be on the page; then it's hidden for the promo */
  async assertMock() {
    await this.until(
      `[...document.querySelectorAll(".topbar-end *")].some((e) => e.textContent.trim() === "Mock data")`,
      15_000,
      "the Mock data badge",
    );
    await this.eval(`(() => {
      for (const e of document.querySelectorAll(".topbar-end *")) if (e.textContent.trim() === "Mock data") e.setAttribute("data-promo-hide", "");
      if (!document.getElementById("promo-css")) {
        const s = document.createElement("style");
        s.id = "promo-css";
        s.textContent = "[data-promo-hide]{visibility:hidden !important}";
        document.head.append(s);
      }
      return true;
    })()`);
  }
  /** every bit of text a frame could show, plus the address */
  async text() {
    return this.eval(`(() => {
      const bits = [location.href, document.title, document.body.innerText];
      for (const e of document.querySelectorAll("[alt],[title],[aria-label],[placeholder]"))
        for (const a of ["alt", "title", "aria-label", "placeholder"]) if (e.getAttribute(a)) bits.push(e.getAttribute(a));
      for (const e of document.querySelectorAll("input,textarea")) if (e.value) bits.push(e.value);
      return bits.join("\\n");
    })()`);
  }
  async scan(where) {
    if (this.mode === "mock")
      await this.eval(
        `(() => { for (const e of document.querySelectorAll(".topbar-end *")) if (e.textContent.trim() === "Mock data") e.setAttribute("data-promo-hide", ""); return true; })()`,
      );
    const text = await this.text();
    const hits = [];
    for (const re of BANNED) {
      const g = new RegExp(re.source, "gi");
      for (const m of text.matchAll(g))
        hits.push(`${re.source}: …${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " ")}…`);
    }
    SCAN.push({ where, chars: text.length, hits });
    if (hits.length) throw new Error(`PRIVATE TEXT on ${where}:\n  ${hits.join("\n  ")}`);
    return text;
  }
  async rects(names = RECTS) {
    const out = {};
    for (const [name, sel] of Object.entries(names)) {
      out[name] = await this.eval(
        `[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height && r.bottom > 0 && r.top < innerHeight).map((r) => [r.x, r.y, r.width, r.height].map((n) => Math.round(n * ${DSF})))`,
      );
      if (!out[name].length) out[name] = null;
    }
    return out;
  }
  async screenshot(file, { fast = false } = {}) {
    const r = await this.send(
      "Page.captureScreenshot",
      { format: "png", optimizeForSpeed: fast, captureBeyondViewport: false },
      30_000,
    );
    mkdirSync(dirname(file), { recursive: true });
    const buf = Buffer.from(r.data, "base64");
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== W * DSF || h !== H * DSF) throw new Error(`${file} is ${w}×${h}, not ${W * DSF}×${H * DSF}`);
    writeFileSync(file, buf);
  }
}

// ---------------------------------------------------------------- the record

/** every page the scan read */
const SCAN = [];
const INDEX = {
  made: new Date().toISOString(),
  viewport: { w: W, h: H, dsf: DSF },
  fps: FPS,
  base: BASE,
  shots: [],
  skipped: [],
};

function mockUrl(path, flags = {}) {
  const q = new URLSearchParams({ mock: "1", ...flags });
  return `${BASE}${path}?${q}`;
}

// ---------------------------------------------------------------- stills and clips

/** clips: the mock's `speed` and the page's animation rate, so a frame is taken every 1000/30/SLOW ms of wall time */
const SLOW = 0.2;
/** the journey's step 2 message (JOURNEY.say): the rules parse reads it into the 3-field question card */
const SAY = "a 30 s pitch for QuestDay, my todo app that turns tasks into quests. no voice. keep it under $3";

/** a fresh tab on a mock address; the flags ride in the URL and stay for the tab */
async function session(cdp, path, flags = {}) {
  const tab = await Tab.open(cdp, "mock");
  tab.flags = { journey: "todo", ...flags };
  if (flags.journey === null) delete tab.flags.journey;
  await tab.load(mockUrl(path, tab.flags));
  if (Number(tab.flags.speed) === SLOW) {
    await tab.send("Animation.enable");
    await tab.send("Animation.setPlaybackRate", { playbackRate: SLOW });
  }
  await sleep(1200);
  return tab;
}

const top = (tab) => tab.eval(`scrollTo({ top: 0, behavior: "instant" }); true`);
/** scrolls so the first `sel` sits `y` CSS px from the viewport's top */
const scrollTo = (tab, sel, y) =>
  tab.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false;
    scrollBy({ top: e.getBoundingClientRect().top - ${y}, behavior: "instant" }); return true; })()`);
/** the innermost element under `sel` that holds `text` (any case), scrolled to `y` CSS px below its scroller's top */
const scrollToText = (tab, sel, text, y) =>
  tab.eval(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent && e.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})).pop();
    if (!e) return false;
    e.scrollIntoView({ block: "start", behavior: "instant" });
    let box = e.parentElement;
    while (box && box !== document.body && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
    if (box && box !== document.body) box.scrollTop -= ${y}; else scrollBy({ top: -${y}, behavior: "instant" });
    return true;
  })()`);
const hasText = (tab, text) => tab.eval(`document.body.innerText.includes(${JSON.stringify(text)})`);
async function untilText(tab, text, timeoutMs = 180_000) {
  await tab.until(`document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs, `"${text}"`);
}
/** Studio's right panel on its Stage tab */
async function stageTab(tab) {
  await tab.click(".ws-right .tab-list [role=tab], .ws-right .tab-list button, .tab-list [role=tab]", "Stage");
  await sleep(700);
}
const pressEscape = (tab) => tab.key("Escape", "Escape", 27);
/** the header's Crew button: the crew drawer */
const openCrew = (tab) => tab.click(".topbar-end button", "Crew");

/** the ids this run made */
const MADE = [];
function record(entry) {
  MADE.push(entry.id);
  INDEX.shots = INDEX.shots.filter((s) => s.id !== entry.id);
  INDEX.shots.push(entry);
}

/** a still: the text scan first (a hit stops before the PNG is written), then the PNG, its rects, an index entry */
async function keep(tab, shot, id, { rects = {}, note } = {}) {
  await sleep(250);
  await tab.scan(id);
  await tab.screenshot(join(OUT, `${id}.png`));
  record({
    shot,
    id,
    kind: "still",
    url: await tab.eval("location.href"),
    flags: tab.flags,
    files: [`${id}.png`],
    frames: 1,
    rects: await tab.rects({ ...RECTS, ...rects }),
    ...(note ? { note } : {}),
  });
  console.log(`  ✓ ${id}`);
}

/** a whole page, top to bottom, at 2× (3840 wide, as tall as the page); rects in that PNG's pixels */
async function keepFull(tab, shot, id, { rects = {}, note } = {}) {
  await tab.scan(id);
  const h = await tab.eval("Math.ceil(document.documentElement.scrollHeight)");
  const r = await tab.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: W, height: h, scale: 1 },
  });
  writeFileSync(join(OUT, `${id}.png`), Buffer.from(r.data, "base64"));
  const boxes = {};
  for (const [name, sel] of Object.entries(rects))
    boxes[name] = await tab.eval(
      `[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => { const r = e.getBoundingClientRect(); return { text: e.innerText.trim().split("\\n")[0].slice(0, 40), box: [r.x, r.y + scrollY, r.width, r.height].map((n) => Math.round(n * ${DSF})) }; }).filter((x) => x.box[2] && x.box[3])`,
    );
  record({
    shot,
    id,
    kind: "full-page",
    size: [W * DSF, h * DSF],
    url: await tab.eval("location.href"),
    flags: tab.flags,
    files: [`${id}.png`],
    frames: 1,
    rects: boxes,
    ...(note ? { note } : {}),
  });
  console.log(`  ✓ ${id} (full page, ${W * DSF}×${h * DSF})`);
}

/**
 * A clip: the mock runs at `speed=SLOW` and the page's CSS animations at SLOW (Animation.setPlaybackRate), and a PNG is
 * taken every 1000/30/SLOW ms of wall time, so each frame is 1/30 s of the app's time. (Virtual time was tried first:
 * Page.captureScreenshot never answers while it is paused, in new headless.) Each frame's real app time is recorded
 * (`appSec`) for the compositor to retime any that came late. `script(f)` drives the page between frames.
 * The camera: `f.pin(sel, y)` holds an element `y` CSS px from the top, `f.pan(sel, y, n)` eases to a new hold.
 */
async function clip(tab, shot, id, script, { rects = {}, note } = {}) {
  const dir = join(OUT, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const period = 1000 / FPS / SLOW;
  const appSec = [];
  let n = 0;
  let late = 0;
  let cam = null; // { sel, y } or a pan { from, to, i, n }
  const camY = async (c) =>
    tab.eval(
      `(() => { const e = document.querySelector(${JSON.stringify(c.sel)}); return e ? scrollY + e.getBoundingClientRect().top - ${c.y} : null; })()`,
    );
  const point = async () => {
    if (!cam) return;
    let y;
    if (cam.pan) {
      const a = await camY(cam.from);
      const b = await camY(cam.to);
      const t = Math.min(1, cam.i++ / cam.n);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      y = a == null ? b : b == null ? a : a + (b - a) * e;
      if (t >= 1) cam = cam.to;
    } else y = await camY(cam);
    if (y != null) await tab.eval(`scrollTo({ top: ${y}, behavior: "instant" }); true`);
  };
  let t0 = null;
  const marks = {};
  const f = {
    mark(name) {
      marks[name] = n;
    },
    async next() {
      t0 ??= performance.now();
      const wait = t0 + n * period - performance.now();
      if (wait > 0) await sleep(wait);
      else if (wait < -period / 2) late++;
      await point();
      const at = performance.now();
      await tab.screenshot(join(dir, `${String(n).padStart(4, "0")}.png`), { fast: true });
      appSec.push(+(((at - t0) * SLOW) / 1000).toFixed(3));
      if (n % 90 === 0) await tab.scan(`${id}#${n}`);
      n++;
    },
    async hold(k) {
      for (let i = 0; i < k; i++) await f.next();
    },
    /** frames until the page expression holds */
    async until(expr, max = 900) {
      for (let i = 0; i < max; i++) {
        if (await tab.eval(`!!(${expr})`)) return;
        await f.next();
      }
      throw new Error(`${id}: never saw ${expr}`);
    },
    pin(sel, y) {
      cam = { sel, y };
    },
    async pan(sel, y, k = 24) {
      cam = { pan: true, from: cam?.pan ? cam.to : cam, to: { sel, y }, i: 0, n: k };
      if (!cam.from) cam = cam.to;
      await f.hold(k);
    },
    get n() {
      return n;
    },
  };
  await script(f);
  await tab.scan(`${id}#last`);
  record({
    shot,
    id,
    kind: "clip",
    url: await tab.eval("location.href"),
    flags: tab.flags,
    files: `${id}/0000.png…${id}/${String(n - 1).padStart(4, "0")}.png`,
    frames: n,
    fps: FPS,
    timing: `paced: mock speed=${SLOW}, CSS animations ×${SLOW}, one PNG per ${period.toFixed(0)} ms wall = 1/30 s app; ${late} late`,
    appSec,
    ...(Object.keys(marks).length ? { marks } : {}),
    rects: await tab.rects({ ...RECTS, ...rects }),
    ...(note ? { note } : {}),
  });
  console.log(`  ✓ ${id} (${n} frames, ${late} late)`);
}

/** a fictional "Q" badge, dropped on the window as questday-logo.png (dragenter, then the drop a moment later) */
async function dragLogo(tab, phase) {
  await tab.eval(`(async () => {
    if (!window.__promoLogo) {
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const g = c.getContext("2d");
      g.fillStyle = "#2f8f5b"; g.fillRect(8, 8, 48, 48); g.fillStyle = "#f5f5f7"; g.font = "bold 40px monospace"; g.fillText("Q", 20, 46);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      window.__promoLogo = new File([blob], "questday-logo.png", { type: "image/png" });
    }
    const dt = new DataTransfer(); dt.items.add(window.__promoLogo);
    for (const t of ${JSON.stringify(phase === "enter" ? ["dragenter", "dragover"] : ["dragover", "drop"])})
      window.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
}

// ---- the shots, by session (the mock's state lives in the page: a session moves inside the app, never reloads) ----

const SESSIONS = {
  /** the pages that need no run: Projects, Library, Settings, Docs, and the twelve faces */
  async pages(cdp) {
    const tab = await session(cdp, "/");
    await keep(tab, "projects", "projects", { rects: { cards: "main article, main li a" } });
    await tab.go("/library");
    await keep(tab, "art-library", "art-library", { rects: { grid: "main ul, main [class*=grid]" } });
    await tab.eval("scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); true");
    await keep(tab, "art-library", "art-library-end");
    // a walk cycle opened from the library, if the cards open one
    await top(tab);
    try {
      await tab.click("main *", "gamers", 5000);
      await sleep(800);
      if (await tab.eval("!!document.querySelector('dialog[open]')"))
        await keep(tab, "art-sheet", "art-sheet-library", { rects: { dialog: "dialog[open]" } });
      await pressEscape(tab);
    } catch {}
    await tab.go("/settings/roles");
    await keep(tab, "settings", "settings-roles");
    await scrollTo(tab, ".roles-crew-label", 90);
    await keep(tab, "settings", "settings-roles-crew", { rects: { roles: ".roles-row" } });
    await top(tab);
    await keepFull(tab, "crew-faces", "crew-faces-roles", {
      rects: {
        pip: ".roles-group:first-of-type .roles-member",
        members: ".roles-member",
        roles: ".roles-row",
        names: ".roles-name",
      },
      note: "Settings › Roles, whole page: Pip, then the crew, each role with its face and name; `roles` boxes are the twelve role rows",
    });
    await tab.go("/settings/models");
    await keep(tab, "settings", "settings-models", { rects: { table: "main table" } });
    await tab.go("/settings/providers");
    await keep(tab, "settings", "settings-providers");
    await tab.go("/docs");
    await keep(tab, "docs", "docs");
    await scrollToText(tab, "h2, h3", "Studio tools", 90);
    await keep(tab, "docs", "docs-tools", { rects: { tools: ".docs-section" } });
    await tab.go("/docs/tools/export_video");
    await keep(tab, "docs", "docs-tool");
    await tab.close();
  },

  /** the brief (a clip), the crew arriving (a clip), then the first pick, the plan and the Studio, by hand at SLOW */
  async brief(cdp) {
    const tab = await session(cdp, "/new", { speed: String(SLOW) });
    await keep(tab, "brief", "brief-empty");
    await clip(tab, "brief", "brief", async (f) => {
      f.pin("main .pip-input", 760);
      await f.hold(15);
      await dragLogo(tab, "enter");
      await f.hold(14);
      await dragLogo(tab, "drop");
      await f.hold(12);
      await f.pan("main .pip-input", 420, 30);
      await tab.click("main .pip-input");
      for (const ch of SAY) {
        await tab.type(ch);
        await f.next();
      }
      await f.hold(15);
      await tab.click("main .pip-send");
      await f.pan("main .pip-input", 90, 30);
      await f.until(`document.body.innerText.includes("A few things the idea leaves open")`);
      await f.hold(45);
      await f.pan("main input[type=radio][value=mine]", 760, 30);
      await f.hold(10);
      await tab.click("main input[type=radio][value=mine]");
      await f.hold(15);
      await tab.click("main button", "Use these");
      await f.until(`document.querySelector("main .brief-card")`);
      await f.pan("main .pip-input", 90, 24);
      await f.hold(50);
      await f.pan("main .brief-card", 130, 36);
      await f.hold(40);
    });
    await clip(
      tab,
      "crew-faces",
      "crew-spawn",
      async (f) => {
        f.pin("main .brief-card", 130);
        await f.hold(12);
        await tab.click("main .brief-card button", "Start");
        f.mark("start");
        await f.until(`document.querySelector("main .crew-faces")`, 120);
        f.mark("cut");
        f.pin("main .pip-face-btn", 330);
        await f.hold(165);
      },
      {
        note: "Start pressed (marks.start), a cut to the crew row (marks.cut): the faces come out of Pip (Writer, Art director), the ghosts, the plan milestone, the first asks",
      },
    );
    await untilText(tab, "Which script should the crew make?", 120_000);
    await sleep(1500);
    await scrollTo(tab, "main .pip-face-btn", 330);
    await keep(tab, "crew-script", "crew-script", { rects: { needs: "[class*=needs-main], [class*=needs-pick]" } });
    await tab.setView("studio");
    await top(tab);
    await keep(tab, "crew-plan", "studio-script");
    await scrollToText(tab, ".ws-right *", "Working ·", 20);
    await keep(tab, "crew-plan", "crew-plan", { rects: { crew: ".crew-row, .crew-group", right: ".ws-right" } });
    await tab.close();
  },

  /** a run to the rough cut (auto, speed 1, scenario=sheet): the code scene, the review notes, the contact sheet */
  async run(cdp) {
    const tab = await session(cdp, "/new", { speed: "1", auto: "1", scenario: "sheet" });
    await tab.until(
      `document.querySelector('main .crew-faces [title*="Animator"][title*="working"], main .crew-faces [aria-label*="Animator"][aria-label*="working"]')`,
      180_000,
      "an Animator at work",
    );
    await sleep(1200);
    await openCrew(tab);
    await sleep(1500);
    await keep(tab, "crew-code", "crew-code", {
      rects: { drawer: "dialog[open]" },
      note: "the crew drawer on who works first: its live step (Writing… with the answer streaming)",
    });
    try {
      await tab.click("dialog[open] button", "Animator · scene", 3000);
      await sleep(1500);
      await keep(tab, "crew-code", "crew-code-animator", {
        rects: { drawer: "dialog[open]" },
        note: "the crew drawer on a working Animator",
      });
    } catch (e) {
      console.warn(`  (no working Animator row: ${e.message})`);
    }
    await pressEscape(tab);
    await untilText(tab, "goes back to the Animator for the headline", 120_000);
    await tab.setView("studio");
    await tab.go("/p/questday_pitch/review");
    await stageTab(tab);
    await keep(tab, "crew-review", "crew-review-journey", { rects: { findings: ".findings, .finding" } });
    await tab.setView("simple");
    await untilText(tab, "The rough cut is ready", 120_000);
    await sleep(2500);
    await top(tab);
    await keep(tab, "crew-board", "roughcut-simple");
    await tab.click("main .preview-btn");
    await sleep(1000);
    await keep(tab, "art-sheet", "art-sheet-contact", { rects: { dialog: "dialog[open]" } });
    try {
      await tab.click("dialog[open] button", "Whole sheet", 3000);
      await sleep(800);
      await keep(tab, "art-sheet", "art-sheet-contact-whole", {
        rects: { dialog: "dialog[open]" },
        note: "the rough cut's contact sheet, every frame",
      });
    } catch (e) {
      console.warn(`  (no whole sheet: ${e.message})`);
    }
    await pressEscape(tab);
    await sleep(500);
    await tab.click("main button", "See who worked");
    await sleep(1500);
    await keep(tab, "crew-faces", "crew-finished", { rects: { drawer: "dialog[open]" } });
    try {
      await tab.click("dialog[open] button", "Pixel artist");
      await sleep(1200);
      await keep(tab, "art-variants", "art-variants-founder", {
        rects: { drawer: "dialog[open]" },
        note: "the Pixel artist's kept log: variants drawn, critiqued, picked",
      });
    } catch (e) {
      console.warn(`  (no Pixel artist row: ${e.message})`);
    }
    await pressEscape(tab);
    await tab.setView("studio");
    for (const [stage, shot] of [
      ["storyboard", "crew-board"],
      ["animate", "crew-code"],
      ["sound", "sound"],
      ["art", "art-variants"],
    ]) {
      await tab.go(`/p/questday_pitch/${stage}`);
      await stageTab(tab);
      await keep(tab, shot, `studio-${stage}`, { rects: { header: ".ws-header", hud: ".ws-header .hud" } });
    }
    await tab.close();
  },

  /** the older Lantern fixture, driven by its own picks: hero variants, the patch history, the Reviewer's findings */
  async lantern(cdp) {
    const tab = await session(cdp, "/p/lantern", { journey: null, speed: "4" });
    const press = () =>
      tab.eval(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.offsetParent && /^(Use this one|Looks good.*|Approve.*|Try again|Go ahead)$/i.test(b.innerText.trim())); if (!b) return null;
        b.scrollIntoView({ block: "nearest", behavior: "instant" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: b.innerText.trim() }; })()`);
    const drive = async (text, timeoutMs = 150_000) => {
      const end = Date.now() + timeoutMs;
      while (!(await hasText(tab, text))) {
        if (Date.now() > end) throw new Error(`lantern: never reached "${text}"`);
        const b = await press();
        if (b) await tab.mouse(b.x, b.y);
        await sleep(1200);
      }
    };
    await drive("Hero drawn");
    await tab.setView("studio");
    await tab.go("/p/lantern/art");
    await stageTab(tab);
    await keep(tab, "art-variants", "art-variants", { rects: { variants: ".variants", asset: ".art-asset" } });
    await tab.click(".tab-list [role=tab], .tab-list button", "Changes");
    await sleep(800);
    await keep(tab, "history", "history", { rects: { changes: ".ws-right" } });
    // the review round needs more presses than the picks above; the journey's crew-review-journey covers it if not
    try {
      await tab.setView("simple");
      await drive("Three findings", 90_000);
      await tab.setView("studio");
      await tab.go("/p/lantern/review");
      await stageTab(tab);
      await keep(tab, "crew-review", "crew-review", { rects: { findings: ".findings", finding: ".finding" } });
    } catch (e) {
      console.warn(`  (lantern review: ${e.message})`);
    }
    await tab.close();
  },

  /** scenario=overrun: the 80% ask and the budget meter with its reserve */
  async overrun(cdp) {
    const tab = await session(cdp, "/new", { speed: "4", auto: "1", scenario: "overrun" });
    await untilText(tab, "near the budget", 180_000);
    await sleep(1500);
    await scrollToText(tab, "main .pip-turn, main article", "Finish within", 140);
    await keep(tab, "budget", "budget-overrun");
    await top(tab);
    await keep(tab, "budget", "budget-overrun-top");
    await tab.setView("studio");
    await top(tab);
    await keep(tab, "budget", "budget-meter", { rects: { hud: ".ws-header .hud" } });
    await tab.close();
  },

  /** scenario=edits: Pip's own free edit, with Undo, and the before and after frames */
  async edits(cdp) {
    const tab = await session(cdp, "/new", { speed: "4", auto: "1", scenario: "edits" });
    await untilText(tab, "The rough cut is ready", 180_000);
    await sleep(1500);
    const seek = (t) =>
      tab.eval(`(() => { const i = document.querySelector("main .viewer-scrub"); if (!i) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${t});
        i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await seek(10.5);
    await sleep(800);
    await top(tab);
    await keep(tab, "pip-edit", "pip-edit-before");
    await tab.click("main .pip-input");
    await tab.type("make the hero bigger in scene 2");
    await sleep(300);
    await keep(tab, "pip-edit", "pip-edit-typed");
    await tab.click("main .pip-send");
    await untilText(tab, "twice the size", 60_000);
    await sleep(1500);
    await scrollToText(tab, "main .pip-turn, main li", "twice the size", 160);
    await keep(tab, "pip-edit", "pip-edit-card");
    await seek(10.5);
    await sleep(800);
    await top(tab);
    await keep(tab, "pip-edit", "pip-edit-after");
    await tab.click("main .pip-input");
    await tab.type("make it in daytime");
    await tab.click("main .pip-send");
    await untilText(tab, "I can do this now", 60_000);
    await sleep(1200);
    await scrollToText(tab, "main .pip-turn, main li", "I can do this now", 160);
    await keep(tab, "pip-edit", "pip-edit-daytime-card");
    try {
      await tab.click("main button", "Do it");
      await sleep(3000);
      await seek(10.5);
      await sleep(800);
      await top(tab);
      await keep(tab, "art-library", "pip-edit-daytime", { note: "the same frame in daytime (Night. Dusk. Day.)" });
    } catch (e) {
      console.warn(`  (daytime: ${e.message})`);
    }
    await tab.close();
  },

  /** the whole journey (auto, speed 8): v1 and the Deliver stage; Projects with the new video. (A change asked after
   * the export is handed to the crew but never exported again in the mock, so there is no v2.) */
  async full(cdp) {
    const tab = await session(cdp, "/new", { speed: "8", auto: "1" });
    await untilText(tab, "Your video is ready. A new", 240_000);
    await sleep(2500);
    await top(tab);
    await keep(tab, "versions", "versions-v1", { rects: { parts: ".sp-parts" } });
    await tab.setView("studio");
    await tab.go("/p/questday_pitch/deliver");
    await stageTab(tab);
    await keep(tab, "versions", "versions-deliver", { rects: { files: ".stage-panel" } });
    await tab.go("/");
    await sleep(1200);
    await keep(tab, "projects", "projects-after");
    await tab.close();
  },
};

/** SHOTS.md ids the mock can't show */
const SKIPPED = [
  {
    shot: "versions",
    what: "v2",
    why: "the mock exports once per journey; a change asked after it is never re-exported, so only v1 exists",
  },
];

async function shots(cdp, only) {
  mkdirSync(OUT, { recursive: true });
  const indexFile = join(OUT, "index.json");
  if (existsSync(indexFile)) {
    const old = JSON.parse(readFileSync(indexFile, "utf8"));
    INDEX.shots = old.shots ?? [];
  }
  const names = only ? only.split(",") : Object.keys(SESSIONS);
  const failed = [];
  for (const name of names) {
    console.log(`session ${name}`);
    const before = SCAN.length;
    try {
      await SESSIONS[name](cdp);
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
      console.error(`  ✕ ${name}: ${e.message}`);
      if (/PRIVATE TEXT/.test(e.message)) throw e;
    }
    void before;
  }
  INDEX.skipped = SKIPPED;
  INDEX.failed = failed;
  INDEX.scan = { pages: SCAN.length, banned: BANNED.map(String), hits: SCAN.flatMap((x) => x.hits) };
  INDEX.notes = [
    "Every request under /api/ was failed in the browser; the mock needs none.",
    "The header's 'Mock data' badge was checked on every page, then hidden (visibility: hidden) for the frames.",
    "Rects are [x, y, w, h] in PNG pixels (CSS px × 2), every visible match of the selector; null when none.",
  ];
  // another run may have written meanwhile: keep its entries, replace ours
  if (existsSync(indexFile)) {
    const now = JSON.parse(readFileSync(indexFile, "utf8")).shots ?? [];
    const mine = new Set(INDEX.shots.map((x) => x.id));
    const fresh = new Set(MADE);
    INDEX.shots = [
      ...now.filter((x) => !fresh.has(x.id)),
      ...INDEX.shots.filter((x) => fresh.has(x.id) || !now.some((y) => y.id === x.id)),
    ];
    void mine;
  }
  // an entry whose PNG is gone (a shot dropped from the list) leaves the index
  INDEX.shots = INDEX.shots.filter((x) =>
    existsSync(join(OUT, Array.isArray(x.files) ? x.files[0] : `${x.id}/0000.png`)),
  );
  writeFileSync(indexFile, `${JSON.stringify(INDEX, null, 1)}\n`);
  console.log(
    `index: ${indexFile} · ${INDEX.shots.length} entries · scanned ${SCAN.length} pages, ${INDEX.scan.hits.length} hits`,
  );
  if (failed.length) console.log(`failed:\n  ${failed.join("\n  ")}`);
}

export { CDP, INDEX, launchChrome, mockUrl, OUT, RECTS, SCAN, Tab };

// ---------------------------------------------------------------- CLI

function arg(name, d = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
}

async function main() {
  const cmd = process.argv[2] ?? "shots";
  const { cdp, close } = await launchChrome();
  try {
    if (cmd === "probe") {
      const tab = await Tab.open(cdp, "mock");
      await tab.load(arg("url"));
      if (arg("wait")) await tab.waitFor(arg("wait"), null, 30_000);
      await sleep(Number(arg("ms", 1500)));
      if (arg("out")) {
        const r = await tab.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(arg("out"), Buffer.from(r.data, "base64"));
      }
      console.log(await tab.text());
      console.log("blocked:", tab.blocked, "external:", [...tab.external]);
      await tab.close();
    } else if (cmd === "still") {
      const url = arg("url");
      const out = arg("out");
      if (!url || !out) throw new Error("still needs --url and --out");
      const reducedMotion = process.argv.includes("--reduced-motion");
      const mode = new URL(url).searchParams.get("mock") === "1" ? "mock" : "real";
      const tab = await Tab.open(cdp, mode, { reducedMotion, allowPipRead: process.argv.includes("--allow-pip-read") });
      await tab.load(url);
      if (arg("view")) await tab.setView(arg("view"));
      if (arg("wait")) await tab.waitFor(arg("wait"), null, 30_000);
      // settle: thought bubbles and faces finish their moves (at least 1.5 s with --reduced-motion)
      await sleep(Math.max(Number(arg("ms", 1500)), reducedMotion ? 1500 : 0));
      await tab.screenshot(out);
      const sels = (arg("rects") ?? STILL_RECTS.join(","))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const rects = await tab.rects(Object.fromEntries(sels.map((s) => [s, s])));
      console.log(
        JSON.stringify(
          { out, url: await tab.eval("location.href"), w: W * DSF, h: H * DSF, rects, blocked: tab.blocked },
          null,
          2,
        ),
      );
      await tab.close();
    } else if (cmd === "shots") {
      await shots(cdp, process.argv[3]);
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
  } finally {
    await close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e.stack ?? e);
    process.exit(1);
  });
