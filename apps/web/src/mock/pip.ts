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
  PipContext,
  PipConversation,
  PipDecision,
  PipEvent,
  PipFile,
  PipItem,
  PipSummary,
  PipTrace,
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
  /** "Make another like this": a draft that copies the project's settings; its id */
  createDraft(from: string): string;
  titles(): { id: string; title: string; state: ProjectState }[];
  /** the newest change that can be undone, for /undo */
  lastChange(id: string): { seq: number; reason: string; by: string } | null;
  undo(id: string, seq: number, reason: string): Promise<void>;
  setCap(id: string, usd: number): void;
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

type Conv = {
  items: PipItem[];
  busy: boolean;
  listeners: Set<(e: ServerEvent) => void>;
  summary: PipSummary | null;
};
/** `decline`: the card's owner hears a decline too (the journey's crew cards: a revision drops its tasks, the budget
 * question settles its other card) */
type Pending = { key: string; card: PipCard; run: (edit?: string) => Promise<void>; decline?: () => void };

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
      c = { items: [], busy: false, listeners: new Set(), summary: null };
      this.convs.set(key, c);
    }
    return c;
  }
  send(key: string, data: PipEvent) {
    // a draft's turns go out on the workspace stream, each event naming its draft (PIP-ORCHESTRATION §4.3)
    const draft = key.startsWith("draft_");
    const e: ServerEvent = { event: "pip", data: structuredClone(draft ? { ...data, draft: key } : data) };
    if (key === WS || draft) for (const l of this.conv(WS).listeners) l(e);
    else this.host.emit(key, e);
  }
  /** /new (mock/drafts.ts): Pip's side of a draft conversation, the card answers and the brief */
  drafts: {
    reply(key: string, text: string): { reply: string; cards: PipCard[] };
    answer(key: string, card: PipCard, values: Record<string, unknown>): void;
    brief(key: string): PipCard;
    files(key: string): string[];
  } | null = null;
  /** Start moved a draft's conversation to its project */
  move(from: string, to: string) {
    const c = this.convs.get(from);
    if (!c) return;
    this.convs.set(to, { ...c, listeners: this.conv(to).listeners });
    this.convs.delete(from);
    for (const p of this.pending.values()) if (p.key === from) p.key = to;
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
      busy: this.conv(project ?? WS).busy,
      summary: structuredClone(this.conv(project ?? WS).summary),
    };
  }
  /** GET /api/pip/context: plausible numbers from the thread (characters / 4) */
  async context(project?: string): Promise<PipContext> {
    await later(250);
    const c = this.conv(project ?? WS);
    const st = project ? this.host.state(project) : null;
    const t4 = (v: unknown) => Math.round(JSON.stringify(v ?? "").length / 4);
    const cut = c.summary ? c.items.findIndex((i) => i.id === c.summary?.upTo) : -1;
    const seen = c.items.slice(cut + 1).slice(-20);
    const conn = this.connections.filter((x) => x.status === "connected");
    const extTools = conn.length;
    const tools = 24 + extTools;
    const parts: PipContext["parts"] = [
      { id: "system", label: "System prompt", tokens: 2840 },
      {
        id: "facts",
        label: "Project facts",
        tokens: st ? 900 + Math.min(6000, t4({ brief: st.doc.brief, budget: st.budget, stage: st.stage })) : 650,
      },
      {
        id: "tools",
        label: "Tool definitions",
        tokens: tools * 145,
        detail: `${tools} tools${extTools ? `, ${extTools} from connections` : ""}`,
      },
      ...(c.summary
        ? [{ id: "summary" as const, label: "Summary of earlier conversation", tokens: t4(c.summary.text) }]
        : []),
      {
        id: "messages",
        label: "Conversation",
        tokens: seen.reduce((a, i) => a + t4(i), 0) + 140 * seen.length,
        detail: `${seen.length} ${seen.length === 1 ? "message" : "messages"}`,
      },
      { id: "reserve", label: "Room for the reply", tokens: 4096 },
    ];
    return {
      model: "anthropic/claude-sonnet-5-5",
      provider: "anthropic",
      window: 200_000,
      method: "estimate",
      mode: "menu",
      windowSource: "table",
      countSource: "chars/4",
      total: parts.reduce((a, x) => a + x.tokens, 0),
      parts,
    };
  }
  /** PUT /api/pip/summary */
  async saveSummary(project: string | undefined, text: string): Promise<PipSummary> {
    await later(200);
    const c = this.conv(project ?? WS);
    const sum = { text, upTo: c.summary?.upTo ?? c.items.at(-1)?.id ?? "", at: iso() };
    c.summary = sum;
    return structuredClone(sum);
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
    const files = key.startsWith("draft_") ? (this.drafts?.files(key) ?? []) : [];
    queueMicrotask(async () => {
      this.push(key, { id: uid("pu"), at: iso(), kind: "user", text, ...(files.length ? { files } : {}) });
      await later(150);
      this.send(key, { type: "thinking" });
      await later(900 + Math.min(900, text.length * 12));
      try {
        const cmd = text.trim().match(/^\/(undo|budget|why|compact)\b\s*(.*)$/i);
        const name = cmd?.[1].toLowerCase();
        if (name === "compact") await later(700);
        const out: { reply: string; cards: PipCard[]; why?: PipTrace & { about?: string } } = cmd
          ? this.command(key, project, name ?? "", cmd[2])
          : key.startsWith("draft_") && this.drafts
            ? this.drafts.reply(key, text)
            : this.reply(key, project, text);
        const trace: PipTrace = cmd
          ? { tools: [], mode: "command", usd: 0, promptVersion: "pip@3" }
          : {
              tools: [
                { name: "project_get", ok: true, ms: 14 },
                ...out.cards.map((c) => ({ name: toolOf(c), ok: true, ms: 40 })),
              ],
              model: "anthropic/claude-sonnet-5-5",
              mode: "menu",
              usage: { inTok: 1800 + text.length * 4, outTok: 90 + out.reply.length },
              usd: 0.002,
              promptVersion: "pip@3",
              cards: out.cards.map((c) => ({ title: cardTitle(c), why: cardWhy(c) })),
            };
        this.push(key, {
          id: uid("pi"),
          at: iso(),
          kind: "pip",
          text: out.reply,
          cards: out.cards,
          model: "mock",
          usd: trace.usd,
          trace,
          ...(out.why ? { why: out.why } : {}),
        });
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
      if (p.decline) {
        if (p.card.type === "plan" && p.card.status !== "proposed")
          throw new ApiError(409, { code: "card_done", message: "Already decided" });
        this.pending.delete(cardId);
        p.decline();
        return structuredClone(this.cardNow(p));
      }
      if (p.card.type === "plan") this.update(p.key, { ...p.card, status: "declined" });
      if (p.card.type === "form" && p.card.form === "mcp_add")
        this.update(p.key, { ...p.card, status: "failed", result: { added: [] } });
      this.pending.delete(cardId);
      return structuredClone(p.card);
    }
    if (p.card.type === "form" && p.card.form === "brief_fields") {
      // "Use these": a bad value is a 400 with a fix, and the card stays open
      this.drafts?.answer(p.key, p.card, d.values ?? {});
      const done: PipCard = { ...p.card, status: "done", values: d.values ?? {} };
      this.update(p.key, done);
      this.pending.delete(cardId);
      const key = p.key;
      queueMicrotask(async () => {
        this.send(key, { type: "thinking" });
        await later(700);
        const brief = this.drafts?.brief(key);
        this.push(key, {
          id: uid("pi"),
          at: iso(),
          kind: "pip",
          text: "Here's the brief.",
          cards: brief ? [brief] : [],
        });
      });
      return structuredClone(done);
    }
    if (p.card.type === "brief") {
      // Start: the project is made before the answer, so the page can go there at once
      if (p.card.status !== "open") throw new ApiError(409, { code: "card_done", message: "Already started" });
      await p.run(d.edit);
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
  card<C extends PipCard>(
    key: string,
    card: C,
    run: (edit?: string) => Promise<void> = async () => {},
    decline?: () => void,
  ): C {
    this.pending.set(card.id, { key, card, run, ...(decline ? { decline } : {}) });
    return card;
  }
  /** a card as its conversation holds it now */
  private cardNow(p: Pending): PipCard {
    for (const i of this.conv(p.key).items)
      if (i.kind === "pip") for (const c of i.cards) if (c.id === p.card.id) return c;
    return p.card;
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

  // ---- slash commands: no model call (but /compact) ----
  command(
    key: string,
    project: string | undefined,
    name: string,
    arg: string,
  ): { reply: string; cards: PipCard[]; why?: PipTrace & { about?: string } } {
    const c = this.conv(key);
    const s = project ? this.host.state(project) : null;
    if (name === "why") {
      const items = c.items.slice(0, -1);
      const prev = [...items].reverse().find((i) => i.kind === "pip" && !!i.trace && i.trace.mode !== "command");
      if (prev?.kind !== "pip" || !prev.trace) return { reply: "There's no answer of mine to explain yet.", cards: [] };
      const idx = items.indexOf(prev);
      const asked = [...items.slice(0, idx)].reverse().find((i) => i.kind === "user");
      return {
        reply: "Here's how I got that answer.",
        cards: [],
        why: { ...prev.trace, about: asked?.kind === "user" ? asked.text : undefined },
      };
    }
    if (name === "compact") {
      const keep = 6;
      const items = c.items.filter((i) => i.kind !== "thinking");
      if (items.length <= keep + 1)
        return { reply: "Nothing to fold yet: the conversation is still short.", cards: [] };
      const folded = items.slice(0, items.length - keep - 1);
      const asks = folded.flatMap((i) => (i.kind === "user" ? [`- You asked: ${i.text}`] : [])).slice(-6);
      const done = folded.flatMap((i) =>
        i.kind === "pip"
          ? i.cards.flatMap((k) => (k.type === "plan" && k.status === "done" ? [`- Done: ${k.title}`] : []))
          : [],
      );
      const text = [...asks, ...done, "- You prefer short answers and approve anything that spends."].join("\n");
      // tokens, estimated as characters / 4: the folded items before, the summary after
      const before = Math.round(folded.reduce((n, i) => n + JSON.stringify(i).length, 0) / 4);
      const after = Math.round(text.length / 4);
      const freed = {
        items: folded.length,
        before,
        after,
        freed: Math.max(0, before - after),
        method: "estimate" as const,
      };
      const summary: PipSummary = { text, upTo: folded.at(-1)?.id ?? "", at: iso(), freed };
      c.summary = summary;
      this.send(key, { type: "summary", summary });
      const f = new Intl.NumberFormat();
      return {
        reply: `Folded ${freed.items} messages into my summary. That freed about ${f.format(freed.freed)} tokens of my context (${f.format(before)} → ${f.format(after)}). You can read and correct it in the divider.`,
        cards: [],
      };
    }
    if (!s || !project) return { reply: "Open a project first: that command works on one project.", cards: [] };
    if (name === "undo") {
      const last = this.host.lastChange(project);
      if (!last) return { reply: "There's nothing to undo yet.", cards: [] };
      const id = uid("card");
      return {
        reply: "This is the newest change.",
        cards: [
          this.card(
            key,
            {
              id,
              type: "plan",
              title: `Undo: ${last.reason}`,
              detail: `Made by ${last.by}. The project goes back to just before it.`,
              who: [],
              usd: null,
              sec: [1, 2],
              effects: ["Nothing else changes."],
              confirmLabel: "Undo it",
              status: "proposed",
            },
            async () => {
              await this.host.undo(project, last.seq, `Undo from Pip: ${last.reason}`);
              const card = this.pending.get(id)?.card;
              if (card?.type === "plan") this.update(key, { ...card, status: "done", result: { text: "Undone." } });
            },
          ),
        ],
      };
    }
    const b = s.budget;
    const n = Number(arg.replace(/[^0-9.]/g, ""));
    const money = (v: number) => `$${v.toFixed(v < 10 ? 2 : 0)}`;
    if (!arg.trim() || !Number.isFinite(n) || n <= 0)
      return { reply: `${budgetWords(s)} To change it: /budget 10.`, cards: [] };
    const id = uid("card");
    const up = n > b.capUsd;
    const more = Math.max(0, Math.round((n - b.capUsd) / 0.08));
    return {
      reply: up ? "Here's what a higher cap allows." : "Here's what a lower cap means.",
      cards: [
        this.card(
          key,
          {
            id,
            type: "plan",
            title: `${up ? "Raise" : "Lower"} the cap to ${money(n)}`,
            detail: `From ${money(b.capUsd)} to ${money(n)}.`,
            who: [],
            usd: null,
            sec: null,
            effects: up
              ? [`Room for about ${more} more steps.`, "The crew still asks at 80% of the new cap."]
              : [
                  n < b.spentUsd + b.reservedUsd
                    ? "That's below what's already spent: the crew stops and asks."
                    : "The crew asks sooner.",
                ],
            confirmLabel: up ? "Raise it" : "Lower it",
            status: "proposed",
          },
          async () => {
            this.host.setCap(project, n);
            const card = this.pending.get(id)?.card;
            if (card?.type === "plan")
              this.update(key, { ...card, status: "done", result: { text: `The cap is ${money(n)} now.` } });
          },
        ),
      ],
    };
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
                if (card?.type === "form" && card.form === "mcp_add")
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
                if (card?.type === "form" && card.form === "mcp_add")
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

    // in a project, another like it is a draft that copies its settings, and the card ends on its stage (PIP-JOURNEY
    // §3.6); in the workspace, a new project waiting at the brief, as before
    if (s && /another|like this|new one|new video|for my|\bfork\b|start a new/.test(t)) {
      const id = uid("card");
      const from = s.doc.id;
      return {
        reply: "I'll start a new video with this one's style, cast and settings. You tell me what it's about.",
        cards: [
          this.card(
            key,
            {
              id,
              type: "plan",
              title: "Make another video like this",
              detail: `A new video with ${s.doc.title}'s style, cast and settings.`,
              who: [],
              usd: [0, 0],
              sec: [1, 2],
              effects: [
                "Copies who it's for, the length, the voice, your picks, the style and the budget.",
                "The idea, the script and the pictures start fresh. Nothing is spent until you press Start.",
              ],
              confirmLabel: "Make it",
              status: "proposed",
            },
            async () => {
              await later(300);
              const draftId = this.host.createDraft(from);
              const card = this.pending.get(id)?.card;
              if (card?.type === "plan")
                this.update(key, {
                  ...card,
                  status: "done",
                  result: { text: "The new video is ready for its idea.", draftId },
                });
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

    if (/how much|cost|money|budget|spend/.test(t) && s) return { reply: budgetWords(s), cards: [] };

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
      return `They're waiting for you: ${low(w.text.replace(/^Waiting for you: /, "")).replace(/[.?!]$/, "")}. "Show me" under my line takes you there.`;
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

// ---- traces for /why ----
function toolOf(c: PipCard): string {
  if (c.type === "files") return "files_list";
  if (c.type === "form") return "connection_add";
  if (c.type === "cant") return "feature_request";
  if (/subtitles/i.test(c.title)) return "subtitles_translate";
  if (/crew/i.test(c.title)) return "crew_request_change";
  return "project_fork";
}
const cardTitle = (c: PipCard) =>
  c.type === "plan" || c.type === "form" ? c.title : c.type === "files" ? "Files" : "Can't";
function cardWhy(c: PipCard): string {
  if (c.type === "plan")
    return c.who.length ? "It changes the video, so the crew does it." : "It writes or spends, so you confirm first.";
  if (c.type === "cant") return "Not supported yet; logged as a request.";
  if (c.type === "form") return "Adding a connection runs something, so you confirm first.";
  return "Reading only, so shown directly.";
}

/** spent, reserved, cap and the estimate, without "$0 cap" or "$0–0" */
function budgetWords(s: ProjectState): string {
  const b = s.budget;
  const m = (v: number) => (v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
  const used = b.spentUsd + b.reservedUsd;
  const spent =
    used <= 0
      ? "Nothing spent yet."
      : `${m(b.spentUsd)} spent${b.reservedUsd > 0 ? `, ${m(b.reservedUsd)} set aside for steps in progress` : ""}.`;
  const cap = b.capUsd > 0 ? ` The cap is ${m(b.capUsd)}.` : " No budget cap is set.";
  const est =
    b.estTotalUsd && b.estTotalUsd[1] > 0
      ? ` The whole video should cost about ${b.estTotalUsd[0] === b.estTotalUsd[1] ? m(b.estTotalUsd[1]) : `${m(b.estTotalUsd[0])} to ${m(b.estTotalUsd[1])}`}.`
      : "";
  return `${spent}${cap}${est}${b.capUsd > 0 ? " The crew asks before going over." : ""}`;
}
