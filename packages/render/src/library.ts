// The asset library in two layers (docs/PIP-ORCHESTRATION.md §1.9). The repo's `library/` (or $PAP_LIBRARY) is a
// read-only seed. The person's own library (settings.paths.library, default <appData>/library) is where the crew's
// publish writes. Search, get, cast and render read both; on an id both have, the user library wins. Moving an asset
// into the seed is a deliberate `pap library promote <id>` (promoteAsset): the standard and rights checks, then the
// seed's index.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkAsset } from "@pap/engine/standard";
import { AssetFile, type AssetFileT } from "@pap/schema";
import { renderSheet } from "./vendor/png.mjs";

export const PAP_ROOT = resolve(new URL("../../../", import.meta.url).pathname);
/** the seed: the repo's public library, read-only at run time */
export const LIBRARY_DIR = process.env.PAP_LIBRARY ?? join(PAP_ROOT, "library");

export type LibraryEntry = { id: string; kind: string; w: number; h: number; frames: number; tags: string[] };
export type LibraryIndex = { palette?: string; assets: LibraryEntry[] };

let userDir: string | undefined;
/** the user library the server's settings name (`settings.paths.library`); unset, it is read from settings.json */
export function setUserLibrary(dir?: string | null) {
  userDir = dir ? resolve(dir) : undefined;
}
/** the person's library: the configured one, else settings.json's paths.library, else <PAP_HOME>/library */
export function userLibraryDir(): string {
  if (userDir) return userDir;
  if (process.env.PAP_USER_LIBRARY) return resolve(process.env.PAP_USER_LIBRARY);
  const home = process.env.PAP_HOME ?? join(homedir(), ".pixelartpitch");
  try {
    const s = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    if (typeof s?.paths?.library === "string" && s.paths.library) return resolve(s.paths.library);
  } catch {}
  return join(home, "library");
}
/** the layers in reading order: the user library first, then the seed (one entry when they are the same folder) */
export function libraryDirs(): string[] {
  const seed = resolve(LIBRARY_DIR);
  const user = userLibraryDir();
  return user === seed ? [seed] : [user, seed];
}

export function readIndex(dir: string): LibraryIndex {
  const f = join(dir, "index.json");
  if (!existsSync(f)) return { assets: [] };
  try {
    const x = JSON.parse(readFileSync(f, "utf8"));
    return { ...x, assets: Array.isArray(x?.assets) ? x.assets : [] };
  } catch {
    return { assets: [] };
  }
}
/** the folder that holds a library asset (the user library's first), or null */
export function libraryAssetDir(id: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null;
  for (const d of libraryDirs()) if (existsSync(join(d, id, "asset.json"))) return join(d, id);
  return null;
}
/** both layers' index entries, the user library's winning on an id both have; `layer` says where each one lives */
export function libraryIndex(): { palette: string; assets: (LibraryEntry & { layer: "user" | "seed" })[] } {
  const seed = resolve(LIBRARY_DIR);
  const out = new Map<string, LibraryEntry & { layer: "user" | "seed" }>();
  let palette = "pap-night@1";
  for (const d of [...libraryDirs()].reverse()) {
    const idx = readIndex(d);
    if (d === seed && idx.palette) palette = idx.palette;
    for (const a of idx.assets)
      if (existsSync(join(d, a.id, "asset.json"))) out.set(a.id, { ...a, layer: d === seed ? "seed" : "user" });
  }
  return { palette, assets: [...out.values()] };
}
/** a file under the library (a palette): the user library's copy first, else the seed's path */
export function libraryFile(...rel: string[]): string {
  for (const d of libraryDirs()) if (existsSync(join(d, ...rel))) return join(d, ...rel);
  return join(LIBRARY_DIR, ...rel);
}

const entryOf = (a: AssetFileT): LibraryEntry => ({
  id: a.id,
  kind: a.kind,
  w: a.w,
  h: a.h,
  frames: a.frames.length,
  tags: a.tags ?? [],
});
function writeEntry(dir: string, a: AssetFileT) {
  const idx = readIndex(dir);
  const assets = [...idx.assets.filter((x) => x.id !== a.id), entryOf(a)];
  writeFileSync(join(dir, "index.json"), `${JSON.stringify({ ...idx, assets }, null, 1)}\n`);
}

/**
 * The crew's publish (lib.publish after the person's yes): the asset and its sheet go into the user library and its
 * index. Never into the seed, and never over an id either layer already has.
 */
export function publishAsset(asset: unknown, sheet: Buffer | null, dir = userLibraryDir()): { dir: string } {
  const a = AssetFile.parse(asset);
  if (resolve(dir) === resolve(LIBRARY_DIR))
    throw Object.assign(new Error("the user library is the repo's seed library"), {
      fix: "set settings.paths.library to a folder of your own (the default is <appData>/library)",
    });
  if (libraryAssetDir(a.id) || existsSync(join(dir, a.id)))
    throw Object.assign(new Error(`the library already has ${a.id}`), { fix: "publish under another id" });
  mkdirSync(join(dir, a.id), { recursive: true });
  writeFileSync(join(dir, a.id, "asset.json"), `${JSON.stringify(a, null, 1)}\n`);
  if (sheet) writeFileSync(join(dir, a.id, "sheet.png"), sheet);
  writeEntry(dir, a);
  return { dir: join(dir, a.id) };
}

/** why an asset may not enter the public seed (RIGHTS.md §5, §6), or [] */
export function promoteRefusals(raw: unknown): string[] {
  const parsed = AssetFile.safeParse(raw);
  if (!parsed.success) return [`not an asset file: ${parsed.error.issues[0]?.message ?? "invalid"}`];
  const a = parsed.data;
  const out: string[] = [];
  if (a.rights.likeness) out.push("it shows a real person's likeness (rights.likeness)");
  if (a.rights.brand || a.rights.trademark) out.push("it is a brand or trademark (rights.brand / rights.trademark)");
  if (!a.rights.public) out.push("its rights aren't public (rights.public is false)");
  if (!a.licence || a.licence === "LicenseRef-Private" || /unknown/i.test(a.licence))
    out.push(`its licence is private or unknown (${a.licence || "none"})`);
  const prov = a.provenance ?? {};
  if (!Object.keys(prov).length) out.push("its provenance is empty");
  if (prov.ref || prov.source === "imported") out.push("it comes from a reference (provenance.ref)");
  if (Array.isArray(prov.sourceAssets) && prov.sourceAssets.length)
    out.push("it derives from other assets (provenance.sourceAssets): check their rights by hand");
  return out;
}

/**
 * `pap library promote <id>`: copy one asset from the user library (`from`) into the public seed (`to`) and its
 * index, after the PAP standard's hard rules and the rights checks. Refuses a likeness, a brand, private or unknown
 * rights, and an id the seed already has (a new version is a deliberate edit, not a promote).
 */
export function promoteAsset(
  id: string,
  o: { from?: string; to?: string } = {},
): { ok: true; dir: string; soft: string[] } | { ok: false; reasons: string[] } {
  const from = resolve(o.from ?? userLibraryDir());
  const to = resolve(o.to ?? LIBRARY_DIR);
  if (from === to) return { ok: false, reasons: ["the user library and the seed are the same folder"] };
  const file = join(from, id, "asset.json");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || !existsSync(file))
    return { ok: false, reasons: [`no asset ${id} in ${from}`] };
  if (existsSync(join(to, id))) return { ok: false, reasons: [`the seed already has ${id}`] };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const reasons = promoteRefusals(raw);
  const a = AssetFile.safeParse(raw);
  if (!a.success) return { ok: false, reasons };
  const pal = JSON.parse(readFileSync(join(to, "palettes", `${a.data.palette.split("@")[0]}.json`), "utf8"));
  const colours = Object.fromEntries(Object.entries<any>(pal.colours).map(([k, v]) => [k, v.hex])) as Record<
    string,
    string
  >;
  const std = checkAsset(raw, { colours, sky: pal.sky });
  for (const i of std.hard) reasons.push(`the standard: ${i.frame ? `${i.frame} ` : ""}${i.message} (fix: ${i.fix})`);
  if (reasons.length) return { ok: false, reasons };
  mkdirSync(join(to, id), { recursive: true });
  writeFileSync(join(to, id, "asset.json"), `${JSON.stringify({ ...a.data, standard: std }, null, 1)}\n`);
  const sheet = join(from, id, "sheet.png");
  if (existsSync(sheet)) copyFileSync(sheet, join(to, id, "sheet.png"));
  else
    writeFileSync(
      join(to, id, "sheet.png"),
      renderSheet(a.data.grid, { colours, bg: pal.sky, scale: 4, columns: a.data.frames.length, gap: 8 }),
    );
  writeEntry(to, a.data);
  return { ok: true, dir: join(to, id), soft: std.soft };
}
