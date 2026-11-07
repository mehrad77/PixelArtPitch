// /new in mock mode (PIP-ORCHESTRATION §3, PIP-JOURNEY §3.5): drafts, their files, and Pip's side of the draft
// conversation. One reading of the idea by the rules parse (the agent-mode read is the server's), then one question
// card with 3 fields or fewer, then the brief card; its Start makes the project and the journey runs it. The draft
// itself spends nothing.
import { ApiError } from "../lib/api.ts";
import { guessType, isSensitive, REF_TYPE_LABEL } from "../lib/brief.ts";
import { FIRST_LINE } from "../lib/stage.ts";
import type {
  BriefFieldAsk,
  BriefFieldKey,
  Draft,
  DraftComposer,
  DraftRef,
  Involvement,
  PipCard,
  PipItem,
  RefType,
  WorkspaceLine,
} from "../lib/types.ts";
import { JOURNEY } from "./journey.ts";

type Stored = { draft: Draft; files: Map<string, string> };
export type DraftHost = {
  /** add a Pip item to a draft's conversation (stored, and sent on /api/events with `draft`) */
  push(draft: string, item: PipItem): void;
  update(draft: string, card: PipCard): void;
  /** keep a card's run server-side, as MockPip does */
  card<C extends PipCard>(draft: string, card: C, run: () => Promise<void>): C;
  thinking(draft: string): void;
  /** Start: make the project from the draft; returns its id */
  start(d: Draft): string;
  /** after the card says so: the conversation moves to the project, the draft goes, and the journey begins */
  started(draft: string, projectId: string): void;
  /** "Make another like this": the project's title and the settings a copy inherits; null for an unknown id */
  copyOf(projectId: string): { title: string; fields: Draft["fields"] } | null;
};

/** what a copy inherits (PIP-ORCHESTRATION §3.4): the settings, never the idea or the files */
export const COPIED: BriefFieldKey[] = [
  "audience",
  "lengthSec",
  "narration",
  "involvement",
  "profile",
  "style",
  "budget",
];
/** Pip's opening line in a copy (PIP-JOURNEY §3.6) */
export const copyLine = (title: string) =>
  `Another one like ${title}: same style, cast and settings. What's this one about?`;

const AUDIENCE = [
  { id: "investors", label: "Investors", purpose: "pitch" },
  { id: "users", label: "Users", purpose: "social" },
  { id: "launch", label: "A launch post", purpose: "launch" },
] as const;
const INVOLVEMENT: { id: Involvement; label: string; short: string; picks: string }[] = [
  { id: "key", label: "Only the key picks", short: "only the key picks", picks: "The key moments" },
  { id: "every", label: "Every step", short: "every step", picks: "Every step" },
  { id: "auto", label: "Let the crew run", short: "the crew runs", picks: "Only the rights" },
];
const RIGHTS: { id: DraftRef["rights"]; label: string }[] = [
  { id: "mine", label: "Mine" },
  { id: "licensed", label: "Licensed" },
  { id: "unsure", label: "Not sure" },
];
const WORDS = ["No", "One", "Two", "Three"];

/** the rules parse (§3.3 step 4): what the idea says, nothing invented */
export function readIdea(text: string): Partial<Record<BriefFieldKey, unknown>> {
  const t = text.toLowerCase();
  const out: Partial<Record<BriefFieldKey, unknown>> = {};
  const len = t.match(/(\d{1,3})\s*(s\b|sec|second)/);
  if (len) out.lengthSec = Math.min(180, Math.max(5, Number(len[1])));
  else if (/half a minute/.test(t)) out.lengthSec = 30;
  else if (/\ba minute\b/.test(t)) out.lengthSec = 60;
  if (/no (voice|narration|vo)\b|silent|captions only/.test(t)) out.narration = "none";
  else if (/i'?ll (record|narrate)|my voice/.test(t)) out.narration = "user";
  const cap = t.match(/(under|max|keep it under|budget)\s*\$?\s*(\d+(\.\d+)?)/);
  if (cap) out.budget = Number(cap[2]);
  if (/investor/.test(t)) out.audience = "investors";
  else if (/\b(users?|customers)\b/.test(t)) out.audience = "users";
  else if (/\blaunch\b/.test(t)) out.audience = "launch";
  if (/let (the crew|it) run|surprise me/.test(t)) out.involvement = "auto";
  else if (/every step/.test(t)) out.involvement = "every";
  const words = [...text.matchAll(/(^|[.!?]\s+|\s)([A-Za-z][A-Za-z0-9]*)/g)];
  const product = words.find((m, i) => i > 0 && !/[.!?]/.test(m[1]) && /^[A-Z][A-Za-z0-9]+$/.test(m[2]))?.[2];
  out.title = product ? `${product} pitch` : text.split(/\s+/).slice(0, 6).join(" ");
  // the idea without the clauses the parse already took
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/^(no (voice|narration|vo)|silent|captions only|keep it under|under \$|budget)/i.test(s.trim()))
    .join(" ")
    .trim();
  const idea = kept.charAt(0).toUpperCase() + kept.slice(1);
  out.idea = /[.!?]$/.test(idea) ? idea : `${idea}.`;
  return out;
}

const usdWords = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export class MockDrafts {
  drafts = new Map<string, Stored>();
  host: DraftHost;
  private n = 0;
  private cardN = 0;
  constructor(host: DraftHost) {
    this.host = host;
  }

  get(id: string): Stored {
    const s = this.drafts.get(id);
    if (!s)
      throw new ApiError(404, {
        code: "no_draft",
        message: "This draft is gone",
        fix: "Start a new video from Projects.",
      });
    return s;
  }
  create(from?: string): { draft: Draft; items: PipItem[] } {
    const copy = from ? this.host.copyOf(from) : null;
    if (from && !copy)
      throw new ApiError(404, {
        code: "no_project",
        message: "That project is gone",
        fix: "Pick a project on the Projects page.",
      });
    const id = `draft_${++this.n}`;
    const now = new Date().toISOString();
    const fields: Draft["fields"] = {};
    const source: Draft["source"] = {};
    for (const k of COPIED)
      if (copy?.fields[k] != null) {
        fields[k] = structuredClone(copy.fields[k]);
        source[k] = "default";
      }
    const draft: Draft = {
      id,
      createdAt: now,
      updatedAt: now,
      title: null,
      fields,
      source,
      refs: [],
      ...(from ? { from } : {}),
    };
    this.drafts.set(id, { draft, files: new Map() });
    const first: PipItem = {
      id: `${id}_pip_0`,
      at: now,
      kind: "pip",
      text: copy ? copyLine(copy.title) : FIRST_LINE,
      cards: [],
    };
    this.host.push(id, first);
    return { draft: structuredClone(draft), items: [first] };
  }
  private announced = new Map<string, Set<string>>();
  /** the files a message carries: those added since the last one */
  announce(id: string): string[] {
    const seen = this.announced.get(id) ?? new Set<string>();
    const fresh = (this.drafts.get(id)?.draft.refs ?? []).map((r) => r.name).filter((n) => !seen.has(n));
    for (const n of fresh) seen.add(n);
    this.announced.set(id, seen);
    return fresh;
  }
  remove(id: string) {
    this.get(id);
    this.drafts.delete(id);
  }
  touch(id: string) {
    const s = this.get(id);
    s.draft.updatedAt = new Date().toISOString();
  }
  addFile(id: string, name: string, body: Blob): DraftRef {
    const s = this.get(id);
    let url = "";
    try {
      url = URL.createObjectURL(body);
    } catch {}
    const type = guessType(name, body.type);
    const ref: DraftRef = { name, url, bytes: body.size, type, rights: "unsure", private: true };
    s.draft.refs = [...s.draft.refs.filter((r) => r.name !== name), ref];
    s.files.set(name, url);
    this.touch(id);
    return structuredClone(ref);
  }
  patchRef(id: string, name: string, patch: { type?: RefType; rights?: DraftRef["rights"] }): DraftRef {
    const s = this.get(id);
    const ref = s.draft.refs.find((r) => r.name === name);
    if (!ref) throw new ApiError(404, { code: "no_ref", message: `No file named ${name}`, fix: "Add the file first." });
    Object.assign(ref, patch);
    this.touch(id);
    return structuredClone(ref);
  }
  setFields(id: string, fields: Draft["fields"]): Draft {
    const s = this.get(id);
    s.draft.fields = { ...s.draft.fields, ...fields };
    for (const k of Object.keys(fields) as BriefFieldKey[]) s.draft.source[k] = "said";
    if (typeof fields.title === "string") s.draft.title = fields.title;
    this.touch(id);
    return structuredClone(s.draft);
  }
  composer(id: string): DraftComposer {
    const f = this.get(id).draft.fields;
    const aud = AUDIENCE.find((a) => a.id === f.audience);
    return {
      title: String(f.title ?? ""),
      brief: {
        idea: String(f.idea ?? ""),
        ...(aud ? { purpose: aud.purpose, audience: aud.label } : {}),
        ...(typeof f.lengthSec === "number" ? { lengthSec: f.lengthSec } : {}),
        ...(f.narration === "none" || f.narration === "user" ? { narration: f.narration } : {}),
        ...(typeof f.involvement === "string" ? { involvement: f.involvement as Involvement } : {}),
        references: this.get(id).draft.refs.map((r) => ({ file: r.name, type: r.type, rights: r.rights, note: "" })),
      },
      budgetUsd: typeof f.budget === "number" ? f.budget : 5,
      profile: "balanced",
    };
  }
  /** Pip's last words, for the draft's card on Projects */
  lastLine(items: PipItem[]): string {
    const last = [...items].reverse().find((i) => i.kind === "pip");
    if (last?.kind !== "pip") return FIRST_LINE;
    const c = last.cards[0];
    if (c?.type === "form" && c.status === "open") return c.title;
    if (c?.type === "brief" && c.status === "open") return "The brief is ready to start.";
    return last.text || FIRST_LINE;
  }

  // ---- the conversation ----
  /** a message in the draft: the first one is read; later ones read again and supersede an open card */
  reply(id: string, text: string): { reply: string; cards: PipCard[] } {
    const s = this.get(id);
    const said = readIdea(text);
    const d = s.draft;
    const first = d.fields.idea == null;
    for (const [k, v] of Object.entries(said) as [BriefFieldKey, unknown][]) {
      if ((k === "idea" || k === "title") && !first) continue;
      d.fields[k] = v;
      d.source[k] = "said";
    }
    if (first) d.title = String(said.title ?? "");
    this.touch(id);
    // what the person said, never what a copy inherited
    const said_ = (k: BriefFieldKey) => d.source[k] === "said";
    const heard = [
      typeof d.fields.lengthSec === "number" && said_("lengthSec") ? `${d.fields.lengthSec} seconds` : "",
      !said_("narration")
        ? ""
        : d.fields.narration === "none"
          ? "no voice"
          : d.fields.narration === "user"
            ? "your voice"
            : "",
      typeof d.fields.budget === "number" && said_("budget") ? `under ${usdWords(d.fields.budget)}` : "",
    ].filter(Boolean);
    const ask = this.open(d);
    const head = heard.length ? `${heard.join(", ").replace(/^./, (c) => c.toUpperCase())}.` : "Got it.";
    if (!ask.length) return { reply: head, cards: [this.brief(id)] };
    const card = this.host.card(
      id,
      {
        id: `c_q${++this.cardN}`,
        type: "form",
        form: "brief_fields",
        title: "A few things the idea leaves open",
        fields: ask,
        status: "open",
      } as PipCard,
      async () => {},
    );
    const n = WORDS[ask.length] ?? String(ask.length);
    return { reply: `${head} ${n} quick ${ask.length === 1 ? "pick" : "picks"}, then I'll sum it up.`, cards: [card] };
  }

  /** what is still open and askable, in priority order, up to 3; a file's rights always ask inline, last */
  private open(d: Draft): BriefFieldAsk[] {
    const refs = d.refs.filter((r) => r.rights === "unsure" && d.source.references !== "asked");
    const files: BriefFieldAsk[] = refs.length
      ? [
          {
            key: "references",
            label:
              refs.length === 1
                ? `Is the ${REF_TYPE_LABEL[refs[0].type].toLowerCase()} yours to use?`
                : "Are these yours to use?",
            type: "files",
            options: RIGHTS.map((r) => ({ id: r.id, label: r.label })),
            value: structuredClone(refs),
          },
        ]
      : [];
    const ASKS: Record<string, BriefFieldAsk> = {
      audience: {
        key: "audience",
        label: "Who's it for?",
        type: "choice",
        options: AUDIENCE.map((a) => ({ id: a.id, label: a.label })),
        recommended: "investors",
      },
      involvement: {
        key: "involvement",
        label: "How involved do you want to be?",
        type: "choice",
        options: INVOLVEMENT.map((a) => ({ id: a.id, label: a.label })),
        recommended: "key",
      },
      lengthSec: {
        key: "lengthSec",
        label: "How long?",
        type: "choice",
        options: [15, 30, 45, 60].map((v) => ({ id: String(v), label: `${v} s` })),
        recommended: "30",
      },
      narration: {
        key: "narration",
        label: "A voice?",
        type: "choice",
        options: [
          { id: "none", label: "No voice, captions only" },
          { id: "user", label: "I'll record it" },
        ],
        recommended: "none",
      },
      budget: {
        key: "budget",
        label: "Up to how much?",
        type: "number",
        min: 1,
        max: 50,
        step: 0.5,
        unit: "$",
        recommended: 3,
      },
    };
    const open = ["audience", "involvement", "lengthSec", "narration", "budget"]
      .filter((k) => d.fields[k as BriefFieldKey] == null)
      .map((k) => ASKS[k]);
    return [...open.slice(0, 3 - files.length), ...files];
  }

  /** "Use these": validate with the registry; a bad value is a 400 with a fix, and the card stays open */
  answer(id: string, card: Extract<PipCard, { type: "form"; form: "brief_fields" }>, values: Draft["fields"]) {
    const s = this.get(id);
    for (const f of card.fields) {
      const v = values[f.key];
      if (f.type === "files") {
        const rows = (Array.isArray(v) ? v : []) as { name: string; type?: RefType; rights?: string }[];
        for (const ref of f.value as DraftRef[]) {
          const row = rows.find((r) => r.name === ref.name);
          if (!row?.rights || !RIGHTS.some((r) => r.id === row.rights))
            throw new ApiError(400, {
              code: "bad_value",
              message: `Say whose ${ref.name} is`,
              fix: "Pick one: Mine, Licensed or Not sure.",
              path: `references/${ref.name}`,
            });
          this.patchRef(id, ref.name, {
            rights: row.rights as DraftRef["rights"],
            ...(row.type ? { type: row.type } : {}),
          });
        }
        s.draft.source.references = "asked";
        continue;
      }
      if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n) || n < (f.min ?? 0) || n > (f.max ?? 1e9))
          throw new ApiError(400, {
            code: "bad_value",
            message: `${f.label} needs a number`,
            fix: `Use ${f.min ?? 0} to ${f.max ?? ""}.`,
            path: f.key,
          });
        s.draft.fields[f.key] = n;
      } else {
        if (!f.options?.some((o) => o.id === v))
          throw new ApiError(400, {
            code: "bad_value",
            message: `Pick one for "${f.label}"`,
            fix: `Use one of: ${f.options?.map((o) => o.label).join(", ")}.`,
            path: f.key,
          });
        s.draft.fields[f.key] = f.key === "lengthSec" ? Number(v) : v;
      }
      s.draft.source[f.key] = "asked";
    }
    this.touch(id);
  }

  /** the brief card: free, from the rules plan only */
  brief(id: string): Extract<PipCard, { type: "brief" }> {
    const d = this.get(id).draft;
    const f = d.fields;
    const len = typeof f.lengthSec === "number" ? f.lengthSec : 30;
    const cap = typeof f.budget === "number" ? f.budget : 3;
    const aud = AUDIENCE.find((a) => a.id === (f.audience ?? "investors")) ?? AUDIENCE[0];
    const inv = INVOLVEMENT.find((a) => a.id === (f.involvement ?? "key")) ?? INVOLVEMENT[0];
    for (const k of ["audience", "involvement", "lengthSec", "narration", "budget"] as BriefFieldKey[])
      if (d.fields[k] == null) d.source[k] = "default";
    const k = len / 30;
    const usd: [number, number] = [+(JOURNEY.estUsd[0] * k).toFixed(2), +(JOURNEY.estUsd[1] * k).toFixed(2)];
    const sec: [number, number] = [Math.round(JOURNEY.estSec[0] * k), Math.round(JOURNEY.estSec[1] * k)];
    const logo = d.refs.find((r) => r.type === "logo");
    const likeness = d.refs.find((r) => r.type === "likeness");
    const sensitive = !!(logo || likeness);
    const scenes = Math.min(6, Math.max(2, Math.round(len / 8)));
    // the rules plan's distinct non-gate instances (the Art director casts in every run; the new drawing's placeholder
    // counts as one), and its tasks (the import only with a logo)
    const crew = 7 + scenes;
    const art = [
      "most art comes from the library",
      "one new drawing",
      ...(logo ? ["your logo in an achievement toast"] : []),
    ];
    const picks =
      inv.id === "auto"
        ? sensitive
          ? "The crew runs on its own; you'll only say yes to your logo."
          : "The crew runs on its own and shows you the finished video."
        : (() => {
            const list =
              inv.id === "every"
                ? ["the script", "the pacing", ...(sensitive ? ["your logo"] : []), "the rough cut", "the final"]
                : ["the script", ...(sensitive ? ["your logo"] : []), "the rough cut"];
            return `You'll pick ${list.length} times: ${andList(list)}.`;
          })();
    const unsure = d.refs.find((r) => isSensitive(r.type) && r.rights === "unsure");
    const warning = unsure
      ? `Not sure blocks the ${REF_TYPE_LABEL[unsure.type].toLowerCase()} until you say. The crew uses a stand-in until then.`
      : usd[1] > cap
        ? `This may pass your ${usdWords(cap)} cap. Raise it to ${usdWords(Math.ceil(usd[1]))}, or ask me for a shorter video. The guard holds at the cap.`
        : undefined;
    const card: Extract<PipCard, { type: "brief" }> = {
      id: `c_b${++this.cardN}`,
      type: "brief",
      title: String(d.title || f.title || "Your video"),
      fields: [
        { key: "idea", label: "Idea", value: String(f.idea ?? "") },
        { key: "lengthSec", label: "Length", value: `${len} s` },
        { key: "narration", label: "Narration", value: f.narration === "user" ? "Your voice" : "None" },
        { key: "audience", label: "For", value: aud.label },
        { key: "involvement", label: "Your picks", value: inv.picks },
        { key: "budget", label: "Budget", value: `Up to ${usdWords(cap)}` },
      ],
      refs: d.refs.map((r) => ({ ...r, label: isSensitive(r.type) ? "Private to this project" : "" })),
      estimate: { usd, sec, rough: true },
      eta: { readyAt: new Date(Date.now() + sec[0] * 1000).toISOString(), deadline: null, late: false },
      preview: {
        crew,
        roles: ["writer", "director", "art-director", "pixel-artist", "animator", "mixer", "reviewer", "editor"],
        tasks: 6 + scenes + (logo ? 1 : 0),
        newArt: 1 + (logo ? 1 : 0),
        fromLibrary: true,
        line: `About ${crew} crew members over the run; ${andList(art)}.`,
      },
      picks,
      ...(warning ? { warning } : {}),
      status: "open",
    };
    return this.host.card(id, card, async () => {
      const projectId = this.host.start(d);
      this.host.update(id, { ...card, status: "started", result: { projectId } });
      this.host.started(id, projectId);
    });
  }

  /** the Projects line from state (§3.4); `rows` are the projects in plain terms */
  static line(
    rows: { id: string; title: string; finishedAt?: number; working?: string; waiting?: number }[],
  ): WorkspaceLine {
    const parts: WorkspaceLine["parts"] = [];
    const day = Date.now() - 24 * 3600 * 1000;
    for (const r of rows)
      if (r.finishedAt && r.finishedAt > day)
        parts.push({ projectId: r.id, kind: "finished", text: `${r.title} is finished.` });
    for (const r of rows)
      if (r.working) parts.push({ projectId: r.id, kind: "working", text: `${r.title} is ${r.working}.` });
    for (const r of rows)
      if (r.waiting)
        parts.push({
          projectId: r.id,
          kind: "waiting",
          text: `${r.title} is waiting on ${r.waiting === 1 ? "one pick" : `${r.waiting} things`} from you.`,
        });
    // at most 3 clauses, ordered finished → working → waiting, so the line ends on what needs the person
    const kept = parts.slice(-3);
    return { text: kept.length ? kept.map((p) => p.text).join(" ") : "Nothing needs you right now.", parts: kept };
  }
}
