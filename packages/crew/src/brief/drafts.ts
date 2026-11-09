// /new as a conversation with Pip (docs/PIP-ORCHESTRATION.md §3, D6, D8): a draft's side of Pip. One reading of the
// idea (Pip's `assistant.brief`, or the rules parse), one question card of 3 fields or fewer (a second only for an
// unsure likeness, voice or logo), then the brief card, whose Start makes the project and runs the crew. The draft
// itself spends nothing but the reading, metered on the workspace guard; the brief card is the rules plan, free.
// Draft turns stream as `pip` events on /api/events with `draft` on each (the third conversation kind).
import { randomUUID } from "node:crypto";
import type { ProjectT, RoleT } from "@pap/schema";
import {
  copyLook,
  type DraftRefT,
  type DraftStore,
  type DraftT,
  newProjectDoc,
  type OpenProject,
  publicDraft,
  type RefTypeT,
  type StoredDraftT,
  StoreError,
  type Workspace,
} from "@pap/tools";
import type { Gateway } from "../gateway.ts";
import { instanceKey } from "../plan/catalogue.ts";
import { envOf, planEstimate } from "../plan/estimate.ts";
import { rulesPlan } from "../plan/rules.ts";
import type { PlanTaskT } from "../plan/schema.ts";
import { openFields, type Reading, readBrief } from "./read.ts";
import {
  ASK_ORDER,
  AUDIENCE,
  type BriefFieldAsk,
  type BriefFieldKey,
  BUDGET,
  briefOf,
  checkCard,
  checkFields,
  DEFAULTS,
  deadlineIso,
  filesAsk,
  guessType,
  INVOLVEMENT,
  ideaOf,
  inheritFrom,
  isSensitive,
  MAX_FIELDS,
  MAX_QUESTION_CARDS,
  type Profile,
  REF_TYPE_LABEL,
  type RefType,
  titleOf,
} from "./registry.ts";

export const FIRST_LINE = "What are we making?";

// ---------------------------------------------------------------- the cards (the UI's PipCard, §4.4)
export type BriefFieldsCard = {
  id: string;
  type: "form";
  form: "brief_fields";
  title: string;
  detail?: string;
  fields: BriefFieldAsk[];
  status: "open" | "submitted" | "done" | "superseded";
  values?: Partial<Record<BriefFieldKey, unknown>>;
};
export type BriefCard = {
  id: string;
  type: "brief";
  title: string;
  fields: { key: BriefFieldKey; label: string; value: string }[];
  refs: (DraftRefT & { label: string })[];
  estimate: { usd: [number, number]; sec: [number, number]; rough: boolean };
  eta: { readyAt: string; deadline: string | null; late: boolean };
  preview: { crew: number; roles: RoleT[]; tasks: number; newArt: number; fromLibrary: boolean; line: string };
  /** the picks line ("You'll pick 3 times: …"), from the plan's gates and rights nodes under the involvement (N16) */
  picks: string;
  warning?: string;
  status: "open" | "started" | "superseded";
  result?: { projectId: string };
};
export type DraftCard = BriefFieldsCard | BriefCard;
export type DraftItem =
  | { id: string; at: string; kind: "user"; text: string; files?: string[] }
  | {
      id: string;
      at: string;
      kind: "pip";
      text: string;
      cards: DraftCard[];
      model?: string;
      usd?: number;
      trace?: {
        tools: { name: string; ok: boolean; ms: number }[];
        model: string;
        mode: "agent" | "menu" | "command";
        usage: { in: number; out: number };
        usd: number;
        promptVersion: string;
        cards?: { title: string; why?: string }[];
      };
    };

export type DraftDeps = {
  store: DraftStore;
  workspace: Workspace;
  gateway: Gateway;
  /** Pip's model and mode for a turn with no project */
  pick: () => { model: string; mode: "agent" | "menu" };
  /** the workspace guard ($1 a day): the reading is metered here */
  budget: () => { key: string; capUsd: number };
  /** a `pip` event on the workspace stream; `draft` goes into the event's data */
  emit: (draft: string, data: { type: "thinking" | "item" | "card"; [k: string]: unknown }) => void;
  /** a local provider is on (the `local` profile may be picked) */
  localOn?: () => boolean;
  /** the settings' profile */
  profile?: () => "best" | "balanced" | "local" | "custom";
  /** role -> model for a profile that isn't the settings' own (null: use the settings) */
  modelsFor?: (profile: Profile) => Promise<Record<string, string> | null>;
  /** Start: the crew runs the new project (not awaited) */
  run?: (p: OpenProject) => void;
};

const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;
const usdWords = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const COUNT = ["no", "one", "two", "three", "four", "five", "six"];
const WORDS = ["No", "One", "Two", "Three"];
const roundUpHalf = (n: number) => Math.ceil(n * 2 - 1e-9) / 2;

/** the files that a draft's references become in the project (Start moves them there) */
const refFile = (name: string) => `private/refs/${name}`;

export class DraftConversations {
  private deps: DraftDeps;
  private busy = new Set<string>();
  constructor(deps: DraftDeps) {
    this.deps = deps;
  }
  private get store() {
    return this.deps.store;
  }

  // ---------------------------------------------------------------- the draft itself
  /** POST /api/drafts: on the first send or drop, never on opening /new (N8). `from`: "Make another like this" */
  create(from?: string): { draft: DraftT; items: DraftItem[] } {
    let fields: Record<string, unknown> = {};
    let opener = FIRST_LINE;
    if (from) {
      const src = this.deps.workspace.get(from);
      fields = inheritFrom(src.doc());
      opener = `Another one like ${src.doc().title}: same style, cast and settings. What's this one about?`;
    }
    const d = this.store.create({
      ...(from ? { from } : {}),
      fields,
      source: Object.fromEntries(Object.keys(fields).map((k) => [k, "said" as const])),
    });
    const first: DraftItem = { id: rid("pip"), at: now(), kind: "pip", text: opener, cards: [] };
    this.append(d.id, first);
    return { draft: publicDraft(d), items: [first] };
  }
  get(id: string): { draft: DraftT; items: DraftItem[] } {
    return { draft: publicDraft(this.store.get(id)), items: this.items(id) };
  }
  items(id: string): DraftItem[] {
    return this.store.items<DraftItem>(id);
  }
  remove(id: string) {
    this.store.remove(id);
  }
  /** GET /api/drafts/:id/files/:name */
  filePath(id: string, name: string) {
    this.store.get(id);
    return this.store.refPath(id, name);
  }
  /** POST /api/drafts/:id/files: rights start `unsure`, the type is guessed from the name; an open brief card follows */
  addFile(id: string, name: string, body: Uint8Array, mime = ""): DraftRefT {
    const ref = this.store.addFile(id, name, body, guessType(name, mime) as RefTypeT);
    this.refreshBrief(id);
    return ref;
  }
  patchRef(id: string, name: string, patch: { type?: unknown; rights?: unknown }): DraftRefT {
    const types = ["likeness", "logo", "style", "as-is", "sound", "voice"];
    if (patch.type !== undefined && !types.includes(String(patch.type)))
      throw new StoreError("bad_value", `${name} needs a file type`, `Use one of: ${types.join(", ")}.`, 400);
    if (patch.rights !== undefined && !["mine", "licensed", "unsure"].includes(String(patch.rights)))
      throw new StoreError("bad_value", `Say whose ${name} is`, "Pick one: Mine, Licensed or Not sure.", 400);
    const ref = this.store.patchRef(id, name, patch as any);
    this.refreshBrief(id);
    return ref;
  }
  /** the open brief card's rebuild after a file change, chained per draft (`fresh` waits for it) */
  private refreshing = new Map<string, Promise<void>>();
  /**
   * An upload, or a ref's type or rights change, rebuilds the open brief card in place (same id, no new message): its
   * files, its price (a logo adds an import, a likeness a drawing) and its warning follow. No model call.
   */
  private refreshBrief(id: string) {
    const prev = this.refreshing.get(id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const last = [...this.items(id)].reverse().find((i) => i.kind === "pip");
        if (last?.kind !== "pip") return;
        const old = last.cards.find((c) => c.type === "brief" && c.status === "open");
        if (!old) return;
        this.saveCard(id, last, { ...(await this.briefCard(id)), id: old.id });
      })
      .catch(() => {});
    this.refreshing.set(id, next);
  }
  /** resolves once the brief card follows every file change made so far */
  fresh(id: string): Promise<void> {
    return this.refreshing.get(id) ?? Promise.resolve();
  }
  /** PATCH /api/drafts/:id {fields}: the composer's "‹ Back to the conversation" (N7), no model call */
  setFields(id: string, fields: Record<string, unknown>): DraftT {
    const d = this.store.get(id);
    const c = checkFields(fields, { localOn: this.deps.localOn?.() });
    if (!c.ok) throw Object.assign(new StoreError("bad_value", c.message, c.fix, 400), { path: c.path });
    for (const [k, v] of Object.entries(c.value)) {
      d.fields[k] = v;
      d.source[k] = "said";
    }
    if (typeof c.value.title === "string") d.title = c.value.title;
    return publicDraft(this.store.save(d));
  }
  /** GET /api/drafts/:id/composer: "Show all options" opens the composer filled from the draft (N7) */
  async composer(id: string): Promise<{
    title: string;
    brief: Partial<ProjectT["brief"]>;
    budgetUsd: number;
    profile: "best" | "balanced" | "local" | "custom";
  }> {
    const d = this.store.get(id);
    const f = d.fields;
    const aud = AUDIENCE.find((a) => a.id === f.audience);
    const budget = typeof f.budget === "number" ? f.budget : (await this.plan(d)).recommendedUsd;
    return {
      title: String(f.title ?? d.title ?? ""),
      brief: {
        idea: String(f.idea ?? ""),
        ...(aud ? { purpose: aud.purpose, audience: aud.audience } : {}),
        ...(typeof f.lengthSec === "number" ? { lengthSec: f.lengthSec } : {}),
        ...(f.narration === "none" || f.narration === "user" ? { narration: f.narration } : {}),
        ...(typeof f.involvement === "string"
          ? { involvement: f.involvement as ProjectT["brief"]["involvement"] }
          : {}),
        ...(Array.isArray(f.style) ? { tone: f.style as string[] } : {}),
        ...(typeof f.deadline === "string" ? { deadline: deadlineIso(f.deadline) } : {}),
        references: d.refs.map((r) => ({ file: r.name, type: r.type, rights: r.rights, note: "" })),
      },
      budgetUsd: budget,
      profile: (f.profile as Profile | undefined) ?? this.deps.profile?.() ?? "best",
    };
  }

  /** a draft as the Projects list shows it (§4.5, N14): zeroed fields, `status.line` is Pip's last question */
  summaries() {
    return this.store.list().map((d) => ({
      id: d.id,
      title: d.title || "New video",
      dir: "",
      rev: 0,
      stage: "brief",
      spentUsd: 0,
      capUsd: 0,
      etaSec: null,
      deadline: null,
      needsYou: 0,
      updatedAt: d.updatedAt,
      createdAt: d.createdAt,
      draft: true as const,
      status: { line: this.lastLine(d.id) },
    }));
  }
  lastLine(id: string): string {
    const last = [...this.items(id)].reverse().find((i) => i.kind === "pip");
    if (last?.kind !== "pip") return FIRST_LINE;
    const c = last.cards[0];
    if (c?.type === "form" && c.status === "open") return c.title;
    if (c?.type === "brief" && c.status === "open") return "The brief is ready to start.";
    return last.text || FIRST_LINE;
  }

  /** GET /api/pip?draft= */
  conversation(id: string) {
    this.store.get(id);
    const { model, mode } = this.deps.pick();
    return { items: this.items(id), name: "Pip", model, mode, busy: this.busy.has(id), summary: null };
  }

  // ---------------------------------------------------------------- the conversation
  private append(id: string, item: DraftItem) {
    this.store.append(id, item);
    this.deps.emit(id, { type: "item", item });
  }
  private saveCard(id: string, item: Extract<DraftItem, { kind: "pip" }>, card: DraftCard) {
    item.cards = item.cards.map((c) => (c.id === card.id ? card : c));
    this.store.append(id, item);
    this.deps.emit(id, { type: "card", itemId: item.id, card });
  }
  private findCard(id: string, cardId: string) {
    for (const it of this.items(id))
      if (it.kind === "pip") {
        const c = it.cards.find((x) => x.id === cardId);
        if (c) return { item: it, card: c };
      }
    return null;
  }
  /** a later message supersedes the open card: it reads again */
  private supersede(id: string) {
    for (const it of this.items(id))
      if (it.kind === "pip")
        for (const c of it.cards)
          if (c.status === "open") this.saveCard(id, it, { ...c, status: "superseded" } as DraftCard);
  }

  /** POST /api/pip {draft, text}: 409 while a turn runs; the turn streams on /api/events */
  ask(id: string, text: string): { turnId: string; done: Promise<DraftItem> } {
    const d = this.store.get(id);
    if (this.busy.has(id))
      throw new StoreError("busy", "Pip is still answering", "wait for the reply, then ask again", 409);
    const t = String(text ?? "")
      .trim()
      .slice(0, 4000);
    // the files dropped since the last message travel with this one (N17)
    const files = d.refs.map((r) => r.name).filter((n) => !d.announced.includes(n));
    if (!t && !files.length)
      throw new StoreError("empty", "say something to Pip", "tell Pip the idea, or add a file", 400);
    d.announced = [...d.announced, ...files];
    this.store.save(d);
    this.busy.add(id);
    const user: DraftItem = { id: rid("u"), at: now(), kind: "user", text: t, ...(files.length ? { files } : {}) };
    this.append(id, user);
    const done = this.turn(id, t, user.id).finally(() => this.busy.delete(id));
    return { turnId: user.id, done };
  }

  private async turn(id: string, text: string, turnId: string): Promise<DraftItem> {
    this.deps.emit(id, { type: "thinking" });
    this.supersede(id);
    if (/^\//.test(text)) return this.say(id, "Commands work inside a project. Here, just tell me the idea.", []);
    const d = this.store.get(id);
    const first = d.fields.idea === undefined || d.fields.idea === null;
    const said = this.items(id)
      .filter(
        (i): i is Extract<DraftItem, { kind: "user" }> => i.kind === "user" && !!i.text && !i.text.startsWith("/"),
      )
      .map((i) => i.text);
    let reading: Reading | null = null;
    if (text) {
      const { model, mode } = this.deps.pick();
      const local = this.deps.gateway.isLocal?.(model) ?? /^(lmstudio|ollama|llamacpp)\//.test(model);
      reading = await readBrief({
        gateway: this.deps.gateway,
        text,
        said,
        known: Object.fromEntries(Object.entries(d.fields).filter(([k]) => k !== "idea" && k !== "title")),
        refs: d.refs.map((r) => ({ name: r.name, type: r.type, rights: r.rights })),
        model,
        mode: local ? "local" : mode,
        budget: this.deps.budget(),
        task: `brief-${turnId}`,
      });
      for (const [k, v] of Object.entries(reading.fields)) {
        d.fields[k] = v;
        d.source[k] = "said";
      }
      if (first) {
        // the idea is the person's own words (the clauses the parse took left out); the title is code's rule
        d.fields.idea = ideaOf(text);
        d.source.idea = "said";
        const title = (reading.how === "pip" ? reading.title : undefined) || titleOf(text);
        d.fields.title = title;
        d.source.title = "said";
        d.title = title;
      }
    }
    this.store.save(d);
    const trace = {
      tools: [],
      model: reading?.model ?? "",
      mode: (reading?.how === "pip" ? "agent" : "menu") as "agent" | "menu",
      usage: { in: 0, out: 0 },
      usd: reading?.usd ?? 0,
      promptVersion: reading?.promptVersion ?? "rules/brief",
    };
    if (d.fields.idea === undefined || d.fields.idea === null)
      return this.say(id, hasFiles(d) ? "Got the file. What's the video about?" : FIRST_LINE, [], trace);
    const heard = [
      typeof d.fields.lengthSec === "number" ? `${d.fields.lengthSec} seconds` : "",
      d.fields.narration === "none" ? "no voice" : d.fields.narration === "user" ? "your voice" : "",
      typeof d.fields.budget === "number" ? `under ${usdWords(d.fields.budget)}` : "",
    ].filter(Boolean);
    const head =
      (reading?.how === "pip" && reading.say) ||
      (heard.length ? `${heard.join(", ").replace(/^./, (c) => c.toUpperCase())}.` : "Got it.");
    const card = await this.questionCard(d, reading?.wording ?? {});
    if (!card) {
      const brief = await this.briefCard(id);
      return this.say(id, `${head} Here's the brief.`, [brief], trace);
    }
    const n = card.fields.length;
    return this.say(
      id,
      `${head} ${WORDS[n] ?? String(n)} quick ${n === 1 ? "pick" : "picks"}, then I'll sum it up.`,
      [card],
      trace,
    );
  }

  private say(id: string, text: string, cards: DraftCard[], trace?: Extract<DraftItem, { kind: "pip" }>["trace"]) {
    const item: DraftItem = {
      id: rid("pip"),
      at: now(),
      kind: "pip",
      text,
      cards,
      ...(trace
        ? {
            model: trace.model,
            usd: +trace.usd.toFixed(6),
            trace: { ...trace, cards: cards.map((c) => ({ title: c.title, why: cardWhy(c) })) },
          }
        : {}),
    };
    this.append(id, item);
    return item;
  }

  /**
   * The one question card (D6): the open, askable fields in priority order with Pip's wording, and the inline rights
   * of files still `unsure`, 3 fields or fewer. Null when nothing is open, or 2 question cards were already asked.
   */
  private async questionCard(
    d: StoredDraftT,
    wording: Reading["wording"],
    second = false,
  ): Promise<BriefFieldsCard | null> {
    if (d.questionCards >= MAX_QUESTION_CARDS) return null;
    const unsure = d.refs.filter((r) => r.rights === "unsure" && !d.asked[r.name]);
    // a second card asks only the rights-sensitive files the first one left unsure (or that came after it)
    const again = second
      ? d.refs.filter((r) => r.rights === "unsure" && isSensitive(r.type) && (d.asked[r.name] ?? 0) === 1)
      : [];
    const files = [...again, ...unsure.filter((r) => !again.includes(r))];
    const fileAsk = files.length ? [filesAsk(files, second && again.length > 0)] : [];
    // a field the brief card already showed with its default is decided: it is never asked later
    const known: Record<string, unknown> = { ...d.fields };
    for (const [k, src] of Object.entries(d.source)) if (src === "default") known[k] ??= "default";
    const fields = second
      ? []
      : openFields(known, wording, MAX_FIELDS - fileAsk.length, (await this.plan(d)).recommendedUsd);
    const all = [...fields, ...fileAsk];
    if (!all.length) return null;
    for (const r of files) d.asked[r.name] = (d.asked[r.name] ?? 0) + 1;
    d.questionCards++;
    this.store.save(d);
    return {
      id: rid("card"),
      type: "form",
      form: "brief_fields",
      title: second ? "One more thing about your files" : "A few things the idea leaves open",
      fields: all,
      status: "open",
    };
  }

  /** POST /api/pip/cards/:cardId {draft, decision, values}: a brief_fields answer, or Start on the brief card */
  async decide(
    id: string,
    cardId: string,
    decision: "confirm" | "decline",
    values?: Record<string, unknown>,
  ): Promise<{ card: DraftCard; done: Promise<unknown> }> {
    const hit = this.findCard(id, cardId);
    if (!hit) throw new StoreError("not_found", `no card ${cardId}`, "use a card id from GET /api/pip?draft=", 404);
    const { item, card } = hit;
    if (card.status !== "open")
      throw new StoreError("already_decided", `this card is ${card.status}`, "answer the newest card", 409);
    if (decision === "decline") {
      const c = { ...card, status: "superseded" } as DraftCard;
      this.saveCard(id, item, c);
      return { card: c, done: Promise.resolve(c) };
    }
    if (card.type === "form") {
      // checked with the registry: a bad value is a 400 with a fix, and the card stays open
      const v = checkCard(card.fields, values ?? {});
      if (!v.ok) throw Object.assign(new StoreError("bad_value", v.message, v.fix, 400), { path: v.path });
      const d = this.store.get(id);
      for (const [k, x] of Object.entries(v.fields)) {
        d.fields[k] = x;
        d.source[k] = "asked";
      }
      for (const r of v.refs) {
        const ref = d.refs.find((x) => x.name === r.name);
        if (ref) Object.assign(ref, { rights: r.rights, ...(r.type ? { type: r.type } : {}) });
      }
      if (v.refs.length) d.source.references = "asked";
      this.store.save(d);
      const done: BriefFieldsCard = { ...card, status: "done", values: (values ?? {}) as BriefFieldsCard["values"] };
      this.saveCard(id, item, done);
      // a second card only when an answer opens a new question; else the brief
      const next = await this.questionCard(this.store.get(id), {}, true);
      if (next) this.say(id, "One more thing, then I'll sum it up.", [next]);
      else this.say(id, "Here's the brief.", [await this.briefCard(id)]);
      return { card: done, done: Promise.resolve(done) };
    }
    // the brief card's confirm is Start: the project exists before the answer, so the page can go there at once
    const p = await this.start(id, item, card);
    return { card: this.findCardIn(item, card.id)!, done: Promise.resolve(p.id) };
  }
  private findCardIn(item: Extract<DraftItem, { kind: "pip" }>, cardId: string) {
    return item.cards.find((c) => c.id === cardId);
  }

  // ---------------------------------------------------------------- the brief card
  /** the rules plan of the document Start would make, and its estimate (free: no model call) */
  private async plan(d: StoredDraftT, budgetUsd?: number) {
    const profile = (d.fields.profile as Profile | undefined) ?? undefined;
    const set = this.deps.profile?.() ?? "best";
    const models = profile && profile !== set ? ((await this.deps.modelsFor?.(profile)) ?? {}) : {};
    const env = envOf(this.deps.gateway as any, models);
    const draft = (cap: number) =>
      newProjectDoc(
        briefOf(
          d.fields,
          d.refs.map((r) => ({ file: refFile(r.name), type: r.type, rights: r.rights })),
          { source: "pip", budgetUsd: cap },
        ),
      );
    const doc0 = draft(budgetUsd ?? 3);
    // the card prices as many drawings per new asset as Settings asks (one: no judge)
    const tasks = rulesPlan(doc0, { env, rev: 0, variants: this.deps.gateway.defaults?.().variants });
    const est = planEstimate(tasks, 0, env);
    const reserve = doc0.budget.reserveUsd;
    const recommendedUsd = Math.min(BUDGET.max, Math.max(BUDGET.min, roundUpHalf(est.usd[1] + reserve)));
    const cap = typeof d.fields.budget === "number" ? d.fields.budget : (budgetUsd ?? recommendedUsd);
    const doc = { ...draft(cap), crew: { profile: profile ?? (set === "custom" ? "custom" : set), models } };
    return { doc, tasks, est, recommendedUsd, cap, models, profile: doc.crew.profile };
  }

  private async briefCard(id: string): Promise<BriefCard> {
    const d = this.store.get(id);
    const f = d.fields;
    // what nobody decided takes the registry's default, and says so
    for (const k of ASK_ORDER) if (f[k] === undefined || f[k] === null) d.source[k] = "default";
    this.store.save(d);
    const { tasks, est, cap } = await this.plan(d);
    const len = typeof f.lengthSec === "number" ? f.lengthSec : DEFAULTS.lengthSec;
    const aud = AUDIENCE.find((a) => a.id === (f.audience ?? DEFAULTS.audience)) ?? AUDIENCE[0];
    const inv = INVOLVEMENT.find((a) => a.id === (f.involvement ?? DEFAULTS.involvement)) ?? INVOLVEMENT[0];
    const preview = previewOf(tasks);
    const picks = picksLine(tasks, inv.id);
    const deadline = typeof f.deadline === "string" ? deadlineIso(f.deadline) : null;
    const readyAt = new Date(Date.now() + est.sec[0] * 1000).toISOString();
    const late = !!deadline && readyAt > deadline;
    const unsure = d.refs.find((r) => isSensitive(r.type) && r.rights === "unsure");
    const warning = unsure
      ? `Not sure blocks the ${REF_TYPE_LABEL[unsure.type].toLowerCase()} until you say. The crew uses a stand-in until then.`
      : est.usd[1] > cap
        ? `This may pass your ${usdWords(cap)} cap. Raise it to ${usdWords(Math.ceil(est.usd[1]))}, or ask me for a shorter video. The guard holds at the cap.`
        : late
          ? "This may finish after your deadline, even before your picks. Ask me for a shorter video, or move the deadline."
          : undefined;
    return {
      id: rid("card"),
      type: "brief",
      title: String(d.title || f.title || "Your video"),
      fields: [
        { key: "idea", label: "Idea", value: String(f.idea ?? "") },
        { key: "lengthSec", label: "Length", value: `${len} s` },
        { key: "narration", label: "Narration", value: f.narration === "user" ? "Your voice" : "None" },
        { key: "audience", label: "For", value: aud.label },
        { key: "involvement", label: "Your picks", value: inv.picks },
        { key: "budget", label: "Budget", value: `Up to ${usdWords(cap)}` },
        ...(deadline ? [{ key: "deadline" as const, label: "Deadline", value: String(f.deadline) }] : []),
        ...(Array.isArray(f.style) && f.style.length
          ? [{ key: "style" as const, label: "Style", value: (f.style as string[]).join(", ") }]
          : []),
      ],
      refs: d.refs.map((r) => ({ ...r, label: isSensitive(r.type as RefType) ? "Private to this project" : "" })),
      estimate: { usd: est.usd, sec: est.sec, rough: est.rough },
      eta: { readyAt, deadline, late },
      preview,
      picks,
      ...(warning ? { warning } : {}),
      status: "open",
    };
  }

  // ---------------------------------------------------------------- Start
  /**
   * Start (§3.1): the project (brief.source "pip"), its refs in private/refs/, the profile, G0 passed by the person,
   * the conversation moved to runs/pip.jsonl, the draft deleted, then the crew runs (rev 0, Pip's revision, the run).
   */
  private async start(id: string, item: Extract<DraftItem, { kind: "pip" }>, card: BriefCard): Promise<OpenProject> {
    const d = this.store.get(id);
    const { doc, cap, models, profile } = await this.plan(d);
    const p = this.deps.workspace.create({ title: doc.title, brief: doc.brief, budgetUsd: cap });
    if (d.from) {
      try {
        const src = this.deps.workspace.get(d.from);
        await copyLook(src, p, { kind: "user" }, { skipPrivate: true, budget: false });
      } catch {}
    }
    const crew = { profile, models: { ...(p.doc().crew.models ?? {}), ...models } };
    if (JSON.stringify(crew) !== JSON.stringify(p.doc().crew))
      await p.patch([{ op: "replace", path: "/crew", value: crew }], {
        reason: "the crew profile picked on /new",
        author: { kind: "user" },
      });
    const started: BriefCard = { ...card, status: "started", result: { projectId: p.id } };
    this.saveCard(id, item, started);
    this.store.moveInto(id, p.dir);
    p.setGate("g0_brief", {
      status: "passed",
      verdict: { by: "user", verdict: "approve", at: now() },
    });
    this.deps.run?.(p);
    return p;
  }

  /**
   * The composer's submit with `draft` ("Show all options", then Start there): the draft's files and conversation
   * move to the project the composer made, and its references point at them. `producer.plan` stays; no model call.
   */
  async adopt(id: string, p: OpenProject) {
    const moved = this.store.moveInto(id, p.dir);
    const refs = p.doc().brief.references.map((r) => (moved[r.file] ? { ...r, file: moved[r.file] } : r));
    const have = new Set(refs.map((r) => r.file));
    const d0 = Object.entries(moved).filter(([, rel]) => !have.has(rel));
    // a file the composer didn't list stays with the project, `unsure`, so nothing uses it unasked
    for (const [, rel] of d0) refs.push({ file: rel, type: "style", rights: "unsure", note: "" });
    const ops: any[] = [{ op: "replace", path: "/brief/references", value: refs }];
    if (!p.doc().brief.source) ops.push({ op: "add", path: "/brief/source", value: "composer" });
    await p.patch(ops, { reason: "the draft's files and conversation moved in", author: { kind: "user" } });
  }
}

const hasFiles = (d: StoredDraftT) => d.refs.length > 0;

function cardWhy(c: DraftCard) {
  return c.type === "form"
    ? `the idea left ${c.fields.map((f) => f.key).join(", ")} open`
    : "every required field is set: the brief, priced from the rules plan";
}

/** the brief card's crew preview (§3.3 step 6): distinct non-gate instances, new art, the line */
export function previewOf(tasks: PlanTaskT[]): BriefCard["preview"] {
  const inst = new Set<string>();
  const roles = new Set<RoleT>();
  let n = 0;
  let drawings = 0;
  let logos = 0;
  let likeness = 0;
  for (const t of tasks) {
    if (t.kind === "gate" || t.role === "person") continue;
    n++;
    roles.add(t.role as RoleT);
    if (t.expand) {
      const k = t.kind === "asset.draw" ? Math.ceil((t.count ?? 0) / 2) : (t.count ?? 0);
      for (let i = 0; i < k; i++) inst.add(instanceKey({ kind: t.kind, scene: `s${i}`, asset: `new${i}` }));
    } else inst.add(t.instance);
    if (t.kind === "asset.spec") {
      const k = t.expand ? (t.count ?? 0) : 1;
      if (t.fromRef) likeness += k;
      else drawings += k;
    }
    if (t.kind === "asset.import") logos++;
  }
  const art = [
    "most art comes from the library",
    ...(drawings ? [`${COUNT[drawings] ?? drawings} new ${drawings === 1 ? "drawing" : "drawings"}`] : []),
    ...(likeness
      ? [`${likeness === 1 ? "a drawing" : `${COUNT[likeness] ?? likeness} drawings`} from your photo`]
      : []),
    ...(logos ? ["your logo in an achievement toast"] : []),
  ];
  const crew = inst.size;
  return {
    crew,
    roles: [...roles],
    tasks: n,
    newArt: drawings + likeness + logos,
    fromLibrary: true,
    line: `About ${crew} crew members over the run; ${andList(art)}.`,
  };
}

/**
 * The picks line (N16) from the plan's gates under the involvement (D2): "key" is the script, each rights node and
 * the rough cut; "every" is all five gates and the rights; "auto" is only the rights (never automatic).
 */
export function picksLine(tasks: PlanTaskT[], involvement: "key" | "every" | "auto"): string {
  const rights = tasks
    .filter((t) => t.kind === "gate" && t.gate === "rights")
    .map((t) => (tasks.some((x) => x.kind === "asset.import" && x.asset === t.asset) ? "your logo" : "the likeness"));
  const uniq = [...new Set(rights)];
  if (involvement === "auto")
    return uniq.length
      ? `The crew runs on its own; you'll only say yes to ${andList(uniq)}.`
      : "The crew runs on its own and shows you the finished video.";
  const list =
    involvement === "every"
      ? ["the script", "the pacing", ...rights, "the rough cut", "the final"]
      : ["the script", ...rights, "the rough cut"];
  return `You'll pick ${list.length} times: ${andList(list)}.`;
}
