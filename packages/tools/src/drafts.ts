// The draft store (docs/PIP-ORCHESTRATION.md §3.1, D8): an unstarted /new conversation, kept in
// $PAP_HOME/drafts/<id>/ and never in a project root or the repo. Only three things are on disk:
//   draft.json   the fields Pip read or asked so far, their source, the dropped files and their rights
//   pip.jsonl    the conversation (Pip's log format: one item per line, the last copy of an id wins)
//   refs/<file>  the dropped files
// There is no pitch.json, so Workspace.list() never sees a draft. Start moves the refs and the conversation into the
// new project and deletes the folder.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { PAP_HOME, StoreError } from "./store.ts";
import { isSvg, rasterizeSvg } from "./svg.ts";

export const DRAFT_ID = /^draft_[a-z0-9]{1,40}$/;
export const RefTypeZ = z.enum(["likeness", "logo", "style", "as-is", "sound", "voice"]);
export type RefTypeT = z.infer<typeof RefTypeZ>;
export const RightsZ = z.enum(["mine", "licensed", "unsure"]);
export const DraftRefZ = z.object({
  name: z.string(),
  url: z.string(),
  bytes: z.number().int().min(0),
  type: RefTypeZ,
  rights: RightsZ,
  /** always: a reference is private to its project (docs/RIGHTS.md §1) */
  private: z.literal(true),
});
export type DraftRefT = z.infer<typeof DraftRefZ>;
export const DraftSource = z.enum(["said", "asked", "default"]);
export const DraftZ = z.object({
  id: z.string().regex(DRAFT_ID),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().max(120).nullable(),
  /** brief field key -> value; the keys and values are checked by the brief field registry (packages/crew) */
  fields: z.record(z.string(), z.unknown()),
  source: z.record(z.string(), DraftSource),
  refs: z.array(DraftRefZ),
  /** "Make another like this": the project it copies */
  from: z.string().optional(),
});
export type DraftT = z.infer<typeof DraftZ>;
/** draft.json: the public draft plus the conversation's own bookkeeping */
export const StoredDraftZ = DraftZ.extend({
  /** the file names a message has already carried (a message carries the ones dropped since the last) */
  announced: z.array(z.string()).default([]),
  /** question cards posted so far (at most 2 before the brief card, D6) */
  questionCards: z.number().int().min(0).default(0),
  /** file name -> how many question cards asked its rights (the second card asks a sensitive one once more) */
  asked: z.record(z.string(), z.number().int().min(0)).default({}),
});
export type StoredDraftT = z.infer<typeof StoredDraftZ>;
export const publicDraft = (d: StoredDraftT): DraftT => {
  const { announced: _a, questionCards: _q, asked: _k, ...rest } = d;
  return structuredClone(rest);
};

export const MAX_REF_BYTES = 20 * 1024 * 1024;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const AUDIO = new Set([".wav", ".mp3", ".m4a", ".ogg", ".webm", ".aac", ".flac"]);

/**
 * A dropped file's name as stored: the last path segment, only letters, digits, dot, dash, underscore and space,
 * at most 80 characters, never hidden. Throws for a name that is empty after that or isn't an image or audio file.
 */
export function safeRefName(raw: string): string {
  const last = String(raw ?? "")
    .replace(/\0/g, "")
    .split(/[\\/]/)
    .pop()!;
  let name = last
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s-]+/, "")
    .trim();
  const ext = extname(name).toLowerCase();
  if (name.length > 80) name = `${name.slice(0, 80 - ext.length)}${ext}`;
  if (!name || name === ext)
    throw new StoreError("bad_name", "the file needs a name", "send ?name=<file name with its extension>", 400);
  if (!IMAGE.has(ext) && !AUDIO.has(ext))
    throw new StoreError(
      "bad_type",
      `${name} isn't an image or a sound file`,
      `use one of: ${[...IMAGE, ...AUDIO].join(", ")}`,
      415,
    );
  return name;
}
export const isAudioName = (name: string) => AUDIO.has(extname(name).toLowerCase());

/** One JSON line per conversation item; an updated item is written again and the last copy wins (as PipLog). */
export function readLog<T extends { id: string }>(file: string): T[] {
  if (!existsSync(file)) return [];
  const byId = new Map<string, T>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const it = JSON.parse(line) as T;
      byId.set(it.id, it);
    } catch {}
  }
  return [...byId.values()];
}

const now = () => new Date().toISOString();

export class DraftStore {
  readonly dir: string;
  constructor(home = PAP_HOME) {
    this.dir = join(home, "drafts");
  }
  private folder(id: string) {
    if (!DRAFT_ID.test(String(id)))
      throw new StoreError("no_draft", "This draft is gone", "Start a new video from Projects.", 404);
    return join(this.dir, id);
  }
  exists(id: string) {
    return DRAFT_ID.test(String(id)) && existsSync(join(this.dir, id, "draft.json"));
  }
  create(input: { from?: string; fields?: Record<string, unknown>; source?: StoredDraftT["source"] } = {}) {
    let id = "";
    do id = `draft_${randomBytes(5).toString("hex")}`;
    while (existsSync(join(this.dir, id)));
    const at = now();
    const d: StoredDraftT = StoredDraftZ.parse({
      id,
      createdAt: at,
      updatedAt: at,
      title: null,
      fields: input.fields ?? {},
      source: input.source ?? {},
      refs: [],
      ...(input.from ? { from: input.from } : {}),
    });
    mkdirSync(join(this.folder(id), "refs"), { recursive: true });
    this.save(d, false);
    return d;
  }
  get(id: string): StoredDraftT {
    const f = join(this.folder(id), "draft.json");
    if (!existsSync(f)) throw new StoreError("no_draft", "This draft is gone", "Start a new video from Projects.", 404);
    return StoredDraftZ.parse(JSON.parse(readFileSync(f, "utf8")));
  }
  save(d: StoredDraftT, touch = true) {
    if (touch) d.updatedAt = now();
    const clean = StoredDraftZ.parse(d);
    const dir = this.folder(clean.id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "draft.json.tmp");
    writeFileSync(tmp, `${JSON.stringify(clean, null, 1)}\n`);
    renameSync(tmp, join(dir, "draft.json"));
    return clean;
  }
  list(): StoredDraftT[] {
    if (!existsSync(this.dir)) return [];
    const out: StoredDraftT[] = [];
    for (const e of readdirSync(this.dir, { withFileTypes: true }))
      if (e.isDirectory() && DRAFT_ID.test(e.name))
        try {
          out.push(this.get(e.name));
        } catch {}
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  remove(id: string) {
    this.get(id);
    rmSync(this.folder(id), { recursive: true, force: true });
  }

  // ---- files ----
  refPath(id: string, name: string) {
    const safe = safeRefName(name);
    if (safe !== name) throw new StoreError("no_ref", `No file named ${name}`, "Add the file first.", 404);
    return join(this.folder(id), "refs", safe);
  }
  addFile(id: string, rawName: string, body: Uint8Array, type: RefTypeT): DraftRefT {
    const d = this.get(id);
    const name = safeRefName(rawName);
    if (body.byteLength > MAX_REF_BYTES)
      throw new StoreError("too_big", `${name} is over 20 MB`, "send a smaller file (at most 20 MB)", 413);
    // an SVG is kept as the source; it must draw (the logo import rasterises it to a 512 px PNG)
    if (extname(name).toLowerCase() === ".svg") {
      const bad = () =>
        new StoreError(
          "bad_image",
          `${name} isn't an SVG that can be drawn`,
          "export the logo again as a plain SVG (no scripts or external images) or as a PNG",
          415,
        );
      if (!isSvg(body)) throw bad();
      try {
        rasterizeSvg(body, 64);
      } catch {
        throw bad();
      }
    }
    mkdirSync(join(this.folder(id), "refs"), { recursive: true });
    writeFileSync(join(this.folder(id), "refs", name), body);
    const ref: DraftRefT = {
      name,
      url: `/api/drafts/${id}/files/${encodeURIComponent(name)}`,
      bytes: body.byteLength,
      type,
      rights: "unsure",
      private: true,
    };
    d.refs = [...d.refs.filter((r) => r.name !== name), ref];
    // a file dropped again is new news for the next message
    d.announced = d.announced.filter((n) => n !== name);
    this.save(d);
    return ref;
  }
  patchRef(id: string, name: string, patch: { type?: RefTypeT; rights?: z.infer<typeof RightsZ> }): DraftRefT {
    const d = this.get(id);
    const ref = d.refs.find((r) => r.name === name);
    if (!ref) throw new StoreError("no_ref", `No file named ${name}`, "Add the file first.", 404);
    if (patch.type) ref.type = RefTypeZ.parse(patch.type);
    if (patch.rights) ref.rights = RightsZ.parse(patch.rights);
    this.save(d);
    return structuredClone(ref);
  }

  // ---- the conversation ----
  logFile(id: string) {
    return join(this.folder(id), "pip.jsonl");
  }
  append(id: string, item: { id: string }) {
    const f = this.logFile(id);
    mkdirSync(join(f, ".."), { recursive: true });
    appendFileSync(f, `${JSON.stringify(item)}\n`);
  }
  items<T extends { id: string }>(id: string): T[] {
    return readLog<T>(this.logFile(id));
  }

  /**
   * Start: the refs go to `<project>/private/refs/`, the conversation to `<project>/runs/pip.jsonl` (after anything
   * already there), and the draft folder is deleted. Returns each ref's path relative to the project.
   */
  moveInto(id: string, projectDir: string): Record<string, string> {
    const d = this.get(id);
    const out: Record<string, string> = {};
    const dest = join(projectDir, "private", "refs");
    for (const r of d.refs) {
      const src = join(this.folder(id), "refs", r.name);
      if (!existsSync(src)) continue;
      mkdirSync(dest, { recursive: true });
      cpSync(src, join(dest, r.name));
      out[r.name] = `private/refs/${r.name}`;
    }
    const log = this.logFile(id);
    if (existsSync(log) && statSync(log).size) {
      mkdirSync(join(projectDir, "runs"), { recursive: true });
      appendFileSync(join(projectDir, "runs", "pip.jsonl"), readFileSync(log));
    }
    rmSync(this.folder(id), { recursive: true, force: true });
    return out;
  }
}
