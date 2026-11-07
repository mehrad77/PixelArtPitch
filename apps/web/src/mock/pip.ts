// Pip in mock mode: scripted replies for the main intents (files, translate, change, another like this, can't,
// add a connection), with cards that run when confirmed. It emits `pip` events the way the server would: the
// person's line, thinking, then Pip's item; a confirmed card goes running → done over its own events.
import { ApiError } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { effectOf, humanStatus, memberOf, PROBLEM_BUTTON, plainTitle, waitReason } from "../lib/human.ts";
import { parseMcpJson } from "../lib/mcp.ts";
import type {
  Connection,
  ConnectionTrust,
  FileRow,
  PipAdded,
  PipCard,
  PipConversation,
  PipDecision,
  PipEvent,
  PipFile,
  PipItem,
  ProjectState,
  ServerEvent,
} from "../lib/types.ts";

/** what the mock backend lends Pip */
export type PipHost = {
  state(id: string): ProjectState | null;
  emit(id: string, e: ServerEvent): void;
  setFiles(id: string, files: FileRow[]): void;
  /** hand a change to the crew: reopens the stage and runs it */
  handoff(id: string, text: string): void;
  createProject(title: string, idea: string): Promise<string>;
  titles(): { id: string; title: string; state: ProjectState }[];
};

const WS = "_workspace";
const iso = () => new Date().toISOString();
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

export function blobUrl(text: string, type = "text/plain") {
  try {
    return URL.createObjectURL(new Blob([text], { type }));
  } catch {
    return "";
  }
}
const srtTime = (t: number) => {
  const ms = Math.round(t * 1000);
  const p = (v: number, w = 2) => String(v).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function srtOf(cues: { text: string; start: number; end: number }[], map = (s: string) => s) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${map(c.text)}\n`).join("\n");
}

const LANGS: [RegExp, string, string, boolean][] = [
  [/persian|farsi/, "fa", "Persian", true],
  [/arabic/, "ar", "Arabic", true],
  [/japanese/, "ja", "Japanese", true],
  [/german/, "de", "German", false],
  [/spanish/, "es", "Spanish", false],
  [/french/, "fr", "French", false],
];
const FAKE_TOOLS = ["search", "get_item", "list_recent", "download", "describe", "tag"];

type Conv = { items: PipItem[]; busy: boolean; listeners: Set<(e: ServerEvent) => void> };
type Pending = { key: string; card: PipCard; run: (edit?: string) => Promise<void> };

export class MockPip {
  convs = new Map<string, Conv>();
  pending = new Map<string, Pending>();
  connections: Connection[] = [];
  host: PipHost;
  constructor(host: PipHost) {
    this.host = host;
  }

  conv(key: string): Conv {
    let c = this.convs.get(key);
    if (!c) {
      c = { items: [], busy: false, listeners: new Set() };
      this.convs.set(key, c);
    }
    return c;
  }
  send(key: string, data: PipEvent) {
    const e: ServerEvent = { event: "pip", data: structuredClone(data) };
    if (key === WS) for (const l of this.conv(WS).listeners) l(e);
    else this.host.emit(key, e);
  }
  push(key: string, item: PipItem) {
    this.conv(key).items.push(item);
    this.send(key, { type: "item", item });
  }
  update(key: string, card: PipCard) {
    const c = this.conv(key);
    c.items = c.items.map((i) =>
      i.kind === "pip" && i.cards.some((x) => x.id === card.id)
        ? { ...i, cards: i.cards.map((x) => (x.id === card.id ? card : x)) }
        : i,
    );
    const p = this.pending.get(card.id);
    if (p) p.card = card;
    this.send(key, { type: "card", card });
  }

  get(project?: string): PipConversation {
    return {
      items: structuredClone(this.conv(project ?? WS).items),
      name: "Pip",
      model: "mock",
      mode: "menu",
    };
  }
  subscribeWorkspace(on: (e: ServerEvent) => void) {
    const c = this.conv(WS);
    c.listeners.add(on);
    return () => c.listeners.delete(on);
  }

  async ask(project: string | undefined, text: string) {
    const key = project ?? WS;
    const c = this.conv(key);
    if (c.busy) throw new ApiError(409, { code: "pip_busy", message: "Pip is still answering" });
    c.busy = true;
    const turnId = uid("turn");
    queueMicrotask(async () => {
      this.push(key, { id: uid("pu"), at: iso(), kind: "user", text });
      await later(150);
      this.send(key, { type: "thinking" });
      await later(900 + Math.min(900, text.length * 12));
      try {
        const { reply, cards } = this.reply(key, project, text);
        this.push(key, { id: uid("pi"), at: iso(), kind: "pip", text: reply, cards, model: "mock", usd: 0.002 });
      } finally {
        c.busy = false;
      }
    });
    return { turnId };
  }

  async decide(cardId: string, d: PipDecision): Promise<PipCard | null> {
    const p = this.pending.get(cardId);
    if (!p) throw new ApiError(404, { code: "no_card", message: "That card is gone" });
    if (d.decision === "decline") {
      if (p.card.type === "plan") this.update(p.key, { ...p.card, status: "declined" });
      if (p.card.type === "form") this.update(p.key, { ...p.card, status: "failed", result: { added: [] } });
      this.pending.delete(cardId);
      return structuredClone(p.card);
    }
    if (p.card.type === "plan") {
      if (p.card.status !== "proposed") throw new ApiError(409, { code: "card_done", message: "Already decided" });
      this.update(p.key, { ...p.card, status: "running" });
    }
    if (p.card.type === "form") this.update(p.key, { ...p.card, status: "submitted" });
    const running = structuredClone(p.card);
    p.run(d.edit).catch((e: Error) => {
      if (p.card.type === "plan")
        this.update(p.key, { ...p.card, status: "failed", result: { text: "", error: e.message } });
    });
    return running;
  }

  /** a card whose run is kept here, server-side, like the real { tool, input } */
  card<C extends PipCard>(key: string, card: C, run: (edit?: string) => Promise<void> = async () => {}): C {
    this.pending.set(card.id, { key, card, run });
    return card;
  }

  // ---- connections ----
  async addConnections(json: string): Promise<{ added: PipAdded[] }> {
    const parsed = parseMcpJson(json);
    if (parsed.error) throw new ApiError(400, { code: "bad_json", message: parsed.error });
    await later(1200);
    const added: PipAdded[] = parsed.servers.map((s) => {
      const broken = /broken/i.test(s.name) || !!s.problem;
      const tools = broken ? [] : FAKE_TOOLS.slice(0, 2 + (s.name.length % 5));
      const conn: Connection = {
        name: s.name,
        transport: s.transport,
        ...(s.transport === "stdio" ? { command: s.command, args: s.args } : { url: s.url }),
        status: broken ? "failed" : "connected",
        tools,
        enabled: true,
        trust: "ask",
        envKeys: s.envKeys,
        headerKeys: s.headerKeys,
        ...(broken
          ? {
              error: s.problem ?? "The command exited before it answered (exit code 127: command not found).",
              fix: `Run it once in a terminal to check it works${s.command ? `: ${[s.command, ...s.args].join(" ")}` : ""}. Install what's missing, then press Test.`,
            }
          : {}),
      };
      this.connections = [...this.connections.filter((c) => c.name !== s.name), conn];
      return broken
        ? { name: s.name, status: "failed", tools: [], error: conn.error, fix: conn.fix }
        : { name: s.name, status: "connected", tools };
    });
    return { added };
  }
  updateConnection(name: string, patch: { enabled?: boolean; trust?: ConnectionTrust }) {
    const c = this.connections.find((x) => x.name === name);
    if (!c) return null;
    Object.assign(c, patch);
    if (patch.enabled === false) c.status = "off";
    if (patch.enabled === true) c.status = c.error ? "failed" : "connected";
    return structuredClone(c);
  }
  removeConnection(name: string) {
    this.connections = this.connections.filter((x) => x.name !== name);
  }
  async testConnection(name: string) {
    await later(700);
    const c = this.connections.find((x) => x.name === name);
    return c ? structuredClone(c) : null;
  }

  // ---- the script ----
  reply(key: string, project: string | undefined, raw: string): { reply: string; cards: PipCard[] } {
    const t = raw.toLowerCase();
    const s = project ? this.host.state(project) : null;

    if (/\bmcp\b|connection|add (a |an )?(new )?server|connect (a |an )?(new )?(server|tool)/.test(t)) {
      const formId = uid("card");
      return {
        reply: "Paste the server's settings below. I'll show what it runs before anything starts.",
        cards: [
          this.card(
            key,
            {
              id: formId,
              type: "form",
              form: "mcp_add",
              title: "Add a connection",
              detail: "An MCP server gives the crew new tools, like music search or your brand kit.",
              status: "open",
            },
            async (edit) => {
              const card = this.pending.get(formId)?.card;
              try {
                const res = await this.addConnections(edit ?? "");
                const ok = res.added.filter((a) => a.status === "connected");
                if (card?.type === "form")
                  this.update(key, { ...card, status: ok.length ? "done" : "failed", result: res });
                const tools = ok.reduce((a, x) => a + x.tools.length, 0);
                this.push(key, {
                  id: uid("pi"),
                  at: iso(),
                  kind: "pip",
                  cards: [],
                  text: ok.length
                    ? `Connected: ${tools} ${tools === 1 ? "tool" : "tools"}. I can use them now.${ok.length < res.added.length ? " One didn't connect; the card says why." : ""}`
                    : "That didn't connect. The card says why and what to try.",
                });
              } catch (e) {
                if (card?.type === "form")
                  this.update(key, {
                    ...card,
                    status: "failed",
                    result: { added: [{ name: "json", status: "failed", tools: [], error: (e as Error).message }] },
                  });
              }
            },
          ),
        ],
      };
    }

    if (/vertical|9:16|portrait|tiktok|\breels?\b|\bshorts\b/.test(t))
      return {
        reply: "Not that one, sorry.",
        cards: [
          {
            id: uid("card"),
            type: "cant",
            text: "Vertical video isn't possible yet: the canvas is 16:9 only. I noted it as a request.",
            nearest: "I can keep the important parts near the centre, so a vertical crop works better later.",
          },
        ],
      };

    if (/subtitle|caption|translat|language|persian|farsi|arabic|german|spanish|french|japanese/.test(t)) {
      if (!s) return { reply: "Open the project first, then ask me there.", cards: [] };
      const lang = LANGS.find(([re]) => re.test(t));
      if (!lang) return { reply: "Which language? Say it in your words, like “Persian” or “Spanish”.", cards: [] };
      const [, code, name, noGlyphs] = lang;
      const base = (s.files.find((f) => f.kind === "video")?.name ?? "pitch.mp4").replace(/\.mp4$/, "");
      const id = uid("card");
      return {
        reply: `I can write ${name} subtitles from your script. The timing stays the same.`,
        cards: [
          this.card(
            key,
            {
              id,
              type: "plan",
              title: `Translate subtitles to ${name}`,
              detail: `A ${name} .srt and .vtt next to the English ones.`,
              who: [],
              usd: [0.01, 0.03],
              sec: [20, 40],
              effects: ["The video doesn't change."],
              ...(noGlyphs
                ? {
                    warning: `As a file only: the pixel font can't draw ${name}, so the picture keeps English captions.`,
                  }
                : {}),
              confirmLabel: "Translate",
              status: "proposed",
            },
            async () => {
              await later(1800);
              const cues = s.timeline.cues;
              const srt = srtOf(cues, (x) => (code === "fa" ? `«${x}» به فارسی` : `[${code}] ${x}`));
              const files: PipFile[] = [
                { name: `${base}.${code}.srt`, kind: "subtitles", sizeBytes: srt.length * 2, url: blobUrl(srt) },
                {
                  name: `${base}.${code}.vtt`,
                  kind: "subtitles",
                  sizeBytes: srt.length * 2 + 8,
                  url: blobUrl(`WEBVTT\n\n${srt.replace(/,(\d{3})/g, ".$1")}`, "text/vtt"),
                },
              ];
              const now = this.host.state(project as string);
              if (now)
                this.host.setFiles(project as string, [
                  ...now.files,
                  ...files.map((f) => ({ name: f.name, url: f.url, bytes: f.sizeBytes, kind: "subtitles" as const })),
                ]);
              const card = this.pending.get(id)?.card;
              if (card?.type === "plan")
                this.update(key, { ...card, status: "done", result: { text: `${name} subtitles are ready.`, files } });
            },
          ),
        ],
      };
    }

    if (/another|like this|new one|new video|for my|\bfork\b|start a new/.test(t)) {
      const id = uid("card");
      const what = raw.match(/for (?:my |our |a )?([\w\s'-]{3,40})/i)?.[1]?.trim();
      const idea = s
        ? `${what ? `A pitch for ${what}, ` : "Another pitch "}in the same style as “${s.doc.title}”: ${s.doc.brief.idea}`
        : `${what ? `A short pitch for ${what}.` : "A short pitch."} Who it's for, and the one thing they should remember.`;
      return {
        reply: s
          ? "I'll set up a new project with this one's style, cast and settings. Check the brief first."
          : "Here's a starting brief. Change anything, then I'll make the project.",
        cards: [
          this.card(
            key,
            {
              id,
              type: "plan",
              title: s ? "Make another video like this" : "Start a new video",
              detail: s
                ? "A new project. The script and pictures start fresh."
                : "A new project, waiting for you at the brief.",
              who: [],
              usd: null,
              sec: [2, 5],
              effects: s
                ? ["Copies settings, cast and style.", "Nothing is spent until you approve the new brief."]
                : ["Nothing is spent until you approve the brief."],
              editable: { field: "brief", label: "Brief", value: idea },
              confirmLabel: "Make it",
              status: "proposed",
            },
            async (edit) => {
              await later(900);
              const title = what ? what.replace(/^./, (c) => c.toUpperCase()) : s ? `${s.doc.title} · 2` : "New pitch";
              const pid = await this.host.createProject(title, edit ?? idea);
              const card = this.pending.get(id)?.card;
              if (card?.type === "plan")
                this.update(key, {
                  ...card,
                  status: "done",
                  result: { text: "Made it. It's waiting for you to check the brief.", projectId: pid },
                });
            },
          ),
        ],
      };
    }

    if (/\bsrt\b|\bvtt\b|\bfiles?\b|download|give me|the video\b|export/.test(t)) {
      if (!s) return { reply: "Which project? Open it and ask me there.", cards: [] };
      const files = s.files
        .filter((f) => f.kind === "video" || f.kind === "subtitles")
        .map((f) => ({ name: f.name, kind: f.kind, sizeBytes: f.bytes, url: f.url }));
      return files.length
        ? { reply: "Here they are.", cards: [{ id: uid("card"), type: "files", files }] }
        : { reply: "There's no video yet. The files show up here once the crew exports it.", cards: [] };
    }

    if (/^change something$/.test(t.trim()))
      return {
        reply: "What should change? Name the scene if you can, like “make the hero bigger in scene 2”.",
        cards: [],
      };

    if (
      /bigger|smaller|larger|change|make the|move|faster|slower|colou?r|shorter|longer|louder|quieter|replace|fix/.test(
        t,
      )
    ) {
      if (!s) return { reply: "Open the project first, then tell me what to change.", cards: [] };
      const scene = Number(t.match(/scene (\d+)/)?.[1]) || 2;
      const id = uid("card");
      const others = s.timeline.scenes.map((_, i) => i + 1).filter((i) => i !== scene);
      const lend = this.connections.filter((c) => c.status === "connected" && c.tools.length);
      return {
        reply: "That's a job for the crew. Here's what would happen.",
        cards: [
          this.card(
            key,
            {
              id,
              type: "plan",
              title: `Ask the crew: ${raw.replace(/[.!]+$/, "")}`,
              detail: `The animator redraws scene ${scene}, then the reviewer checks it.`,
              who: ["animator", "reviewer"],
              usd: [0.2, 0.5],
              sec: [120, 300],
              effects: [
                `Reopens Pictures. Scene${others.length > 1 ? "s" : ""} ${others.join(", ").replace(/, (\d+)$/, " and $1")} stay as they are.`,
                "The video is exported again; the one you have now is kept.",
              ],
              ...(lend.length ? { lend: [`${lend[0].name}.${lend[0].tools[0]}`] } : {}),
              confirmLabel: "Ask the crew",
              status: "proposed",
            },
            async () => {
              await later(500);
              this.host.handoff(project as string, raw);
              const card = this.pending.get(id)?.card;
              if (card?.type === "plan")
                this.update(key, {
                  ...card,
                  status: "done",
                  result: { text: "The animator has it. The reviewer looks after." },
                });
            },
          ),
        ],
      };
    }

    if (/how much|cost|money|budget|spend/.test(t) && s) {
      const b = s.budget;
      return {
        reply: `So far $${(b.spentUsd + b.reservedUsd).toFixed(2)} of the $${b.capUsd} cap.${b.estTotalUsd ? ` The whole video should land around $${b.estTotalUsd[0].toFixed(0)}–${b.estTotalUsd[1].toFixed(0)}.` : ""} The crew asks before going over.`,
        cards: [],
      };
    }

    if (/each project|all.*projects|projects doing/.test(t)) {
      const list = this.host.titles();
      return {
        reply: list.length
          ? list.map((p) => `${p.title}: ${humanStatus(p.state).text.replace(/\.$/, "")}.`).join(" ")
          : "No projects yet. Ask me to start one.",
        cards: [],
      };
    }

    if (s && /how long|when will|until it'?s done|time left|\beta\b|finish/.test(t))
      return { reply: etaAnswer(s), cards: [] };
    if (s && /what|how|where|when|why|explain|doing|wrong|need|status/.test(t))
      return { reply: statusAnswer(s), cards: [] };

    return {
      reply: s
        ? "I can get your files, translate the subtitles, pass a change to the crew, or start another video like this one."
        : "I can start a new video, tell you how each project is doing, or add a connection.",
      cards: [],
    };
  }
}

// ---- status answers: a real sentence from the project's state, not the status line again ----
const low = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function statusAnswer(s: ProjectState): string {
  const w = waitReason(s);
  const working = s.tasks.filter((x) => x.status === "working");
  switch (w.kind) {
    case "needs":
      return `They're waiting for you: ${low(w.text.replace(/^Waiting for you: /, ""))}. "Show me" under my line takes you there.`;
    case "problem":
      return `The crew stopped: ${low(w.problem?.text ?? w.text).replace(/\.$/, "")}. "${w.problem ? PROBLEM_BUTTON[w.problem.action] : "Try again"}" under my line fixes it.`;
    case "paused":
      return `Nobody's working: ${low(w.text).replace(/\.$/, "")}. ${effectOf({ kind: "resume" }, s).text || "Resume picks up where they left off."} Nothing is spent while paused.`;
    case "not_started":
      return `Nobody has started yet. ${effectOf({ kind: "start" }, s).text.replace(/^Starts/, "Start sends")}`;
    case "stopped": {
      const e = w.stage ? effectOf({ kind: "continue", stage: w.stage }, s).text : "";
      return `Nobody's working right now. ${w.text}${e ? ` Continue ${low(e).replace(/^restarts/, "restarts")}` : ""}`;
    }
    case "finished":
      return "Everyone's done. The video and its subtitles are ready to download under my line.";
    case "queued":
      return `${w.text}. Nothing is lost while they wait.`;
    default: {
      if (!working.length) return "They're between steps; the next one starts in a moment.";
      const who = working.map((x) => `the ${memberOf(x.role).label.toLowerCase()} is ${low(plainTitle(x, s))}`);
      const said = andList(who);
      return `${said.charAt(0).toUpperCase()}${said.slice(1)}. ${w.kind === "working" ? `${w.text}.` : ""}`.trim();
    }
  }
}

function etaAnswer(s: ProjectState): string {
  const w = waitReason(s);
  const eta = s.time.etaSec ? (s.time.etaSec[0] + s.time.etaSec[1]) / 2 : 0;
  const asks = s.gates.filter((g) => g.status === "locked").length;
  switch (w.kind) {
    case "finished":
      return "It's done already. Download is under my line.";
    case "needs":
      return `It's waiting on you right now, so the clock is stopped.${eta ? ` After you answer, about ${duration(eta)} more.` : ""}`;
    case "problem":
      return "Nothing moves until the problem is fixed. Once it is, I can give you a time.";
    case "paused":
      return `It's paused, so no clock is running.${eta ? ` Resume and it needs about ${duration(eta)} more.` : ""}`;
    case "stopped":
    case "not_started": {
      const act = w.kind === "stopped" ? "Continue" : "Start";
      return `Nothing is running, so there's no clock yet.${eta ? ` Press ${act} and it needs about ${duration(eta)}` : ` Press ${act} and I'll know more once the first step runs`}${asks ? `, plus the time you take on ${asks} ${asks === 1 ? "check" : "checks"}.` : "."}`;
    }
    default:
      return eta
        ? `About ${duration(eta)} if nothing needs you${asks ? `; the crew will stop ${asks} more ${asks === 1 ? "time" : "times"} for you to check` : ""}.`
        : "Soon, but I can't say how long yet: the next step hasn't given an estimate.";
  }
}
