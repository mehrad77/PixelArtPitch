// PAP standard v1 for sprite asset files (AssetFile in @pap/schema). Hard rules are deterministic and block an asset;
// soft notes are what a vision reviewer should look at. Tuned so every public library asset passes.
import { AssetFile } from "@pap/schema";
import { contrast } from "./painter/check.mjs";

export type StdIssue = { rule: string; frame?: string; message: string; fix: string };
export type StdResult = { ok: boolean; hard: StdIssue[]; soft: string[]; stats: Record<string, number> };
export type StdPalette = { colours: Record<string, string>; sky: string };

type Size = [number, number];
/** allowed sizes per kind: a list of exact sizes, or bounds (w and h multiples of `step`, at most max) */
export const SIZE_CLASSES: Record<string, { sizes?: Size[]; max?: Size; step?: number; doc: string }> = {
  character: { sizes: [[16, 24]], doc: "16x24" },
  creature: {
    sizes: [
      [16, 16],
      [16, 24],
    ],
    doc: "16x16 or 16x24",
  },
  crowd: { max: [96, 24], step: 16, doc: "w a multiple of 16 up to 96, h 16 or 24" },
  prop: {
    sizes: [
      [24, 32],
      [16, 16],
      [16, 32],
    ],
    doc: "24x32, 16x32 or 16x16",
  },
  icon: {
    sizes: [
      [12, 12],
      [16, 16],
      [8, 8],
    ],
    doc: "12x12, 16x16 or 8x8",
  },
  block: { sizes: [[16, 16]], doc: "16x16" },
  tile: { sizes: [[16, 16]], doc: "16x16" },
  "map-tile": { sizes: [[16, 16]], doc: "16x16" },
  building: { max: [128, 112], step: 8, doc: "multiples of 8, up to 128x112" },
  backdrop: { max: [320, 90], step: 16, doc: "w a multiple of 16 (tileable), up to 320x90" },
  decor: { max: [32, 32], doc: "up to 32x32" },
  font: { sizes: [[5, 8]], doc: "5x8" },
  logo: { max: [96, 48], doc: "up to 96x48" },
};
const CHARACTER_FRAMES = ["idle0", "idle1", "run0", "run1", "run2", "run3", "jump", "wave"];
/** kinds whose silhouette must read on the night sky */
const ON_SKY = new Set(["character", "creature", "crowd", "prop", "icon", "block", "decor", "logo"]);
/** share of silhouette edge cells that must reach 1.7:1 against the sky, per frame */
export const EDGE_PASS = 0.4;
export const EDGE_MIN = 1.7;
/** a loop swap (idle0<->idle1, the run cycle) may repaint at most this share of the opaque cells */
export const SWAP_CAP = 0.5;

const opaque = (rows: string[]) => rows.join("").replace(/\./g, "").length;

/**
 * Edge contrast on a dark sky: dark outline ink (cells under 1.25:1 against the sky, like "k") does not show at night,
 * so the edge that reads is the first ring of non-ink cells next to transparency or ink. Returns the share of those
 * cells at or above `min`:1 against the sky (1 when the frame has none).
 */
export function silhouetteContrast(rows: string[], colours: Record<string, string>, sky: string, min = EDGE_MIN) {
  const ink = new Set(Object.keys(colours).filter((k) => contrast(colours[k], sky) < 1.25));
  const at = (x: number, y: number) => rows[y]?.[x] ?? ".";
  const outside = (c: string) => c === "." || ink.has(c);
  let edges = 0;
  let pass = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (outside(c) || !colours[c]) continue;
      if (![at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some(outside)) continue;
      edges++;
      if (contrast(colours[c], sky) >= min) pass++;
    }
  });
  return { edges, pass, ratio: edges ? pass / edges : 1 };
}

/** opaque cells with no opaque neighbour in all 8 directions */
export function orphans(rows: string[]): [number, number][] {
  const out: [number, number][] = [];
  const at = (x: number, y: number) => rows[y]?.[x] ?? ".";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === ".") continue;
      let alone = true;
      for (let j = -1; j <= 1 && alone; j++)
        for (let i = -1; i <= 1; i++) if ((i || j) && at(x + i, y + j) !== ".") alone = false;
      if (alone) out.push([x, y]);
    }
  });
  return out;
}

const diff = (a: string[], b: string[]) => {
  let n = 0;
  for (let y = 0; y < Math.max(a.length, b.length); y++)
    for (let x = 0; x < Math.max(a[y]?.length ?? 0, b[y]?.length ?? 0); x++)
      if ((a[y]?.[x] ?? ".") !== (b[y]?.[x] ?? ".")) n++;
  return n;
};

/** Check one asset file against PAP standard v1. */
export function checkAsset(input: unknown, palette: StdPalette): StdResult {
  const hard: StdIssue[] = [];
  const soft: string[] = [];
  const stats: Record<string, number> = {};
  const add = (rule: string, message: string, fix: string, frame?: string) => hard.push({ rule, frame, message, fix });
  const parsed = AssetFile.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 10))
      add(
        "shape",
        `${i.path.join(".") || "asset"}: ${i.message}`,
        "match the AssetFile shape in packages/schema/src/doc.ts",
      );
    return { ok: false, hard, soft, stats };
  }
  const a = parsed.data;
  // rights and licence
  if (!a.licence.trim())
    add("rights", "licence is empty", 'set "licence", e.g. "LicenseRef-PAP-Library" or an SPDX id');
  if (!Object.keys(a.provenance).length)
    add(
      "rights",
      "provenance is empty",
      'say where it came from: { "source": "generated", "role": "pixel-artist", ... }',
    );
  if (a.rights.likeness)
    soft.push("It depicts a real person (rights.likeness): check consent and that it is flagged private if needed.");
  if (a.rights.brand || a.rights.trademark) soft.push("It carries a brand or trademark: check the project may use it.");
  // size class
  const sc = SIZE_CLASSES[a.kind];
  if (sc) {
    const okSize = sc.sizes
      ? sc.sizes.some(([w, h]) => w === a.w && h === a.h)
      : a.w <= sc.max![0] &&
        a.h <= sc.max![1] &&
        (!sc.step || a.w % sc.step === 0) &&
        (a.kind !== "building" || a.h % 8 === 0);
    if (!okSize) add("size", `${a.kind} is ${a.w}x${a.h}`, `a ${a.kind} is ${sc.doc}`);
    if (a.kind === "crowd" && a.h !== 16 && a.h !== 24) add("size", `crowd height ${a.h}`, "a crowd is 16 or 24 tall");
  }
  // frames listed = frames drawn
  const names = Object.keys(a.grid);
  const missingGrid = a.frames.filter((f) => !a.grid[f]);
  const unlisted = names.filter((f) => !a.frames.includes(f));
  if (missingGrid.length)
    add(
      "frames",
      `frames listed but not drawn: ${missingGrid.join(", ")}`,
      "draw them in grid or drop them from frames",
    );
  if (unlisted.length) add("frames", `frames drawn but not listed: ${unlisted.join(", ")}`, "add them to frames");
  if (!names.length) add("frames", "no frames", "draw at least one frame");
  // required frames
  const npc = a.tags.includes("npc");
  const need =
    a.kind === "character"
      ? npc
        ? ["idle0"]
        : CHARACTER_FRAMES
      : a.kind === "creature"
        ? ["idle0", "idle1"]
        : a.kind === "font"
          ? [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].map((c) => `g${c.codePointAt(0)}`)
          : [];
  const lacking = need.filter((f) => !a.grid[f]);
  if (lacking.length)
    add(
      "frames",
      `missing required frames: ${lacking.join(", ")}`,
      a.kind === "character" && !npc
        ? `a hero needs ${CHARACTER_FRAMES.join(", ")} (or tag it "npc" if it never walks)`
        : "draw them",
    );
  // grid shape and legend
  for (const [f, rows] of Object.entries(a.grid)) {
    // an icon or logo may carry a "big" frame at twice its size (an imported logo's 32x32, for flags and end cards)
    const big = f === "big" && (a.kind === "icon" || a.kind === "logo");
    const fh = big ? a.h * 2 : a.h;
    const fw = big ? a.w * 2 : a.w;
    if (rows.length !== fh)
      add("grid", `${rows.length} rows, expected ${fh}`, `make every frame exactly ${fh} rows`, f);
    rows.forEach((r, y) => {
      if (r.length !== fw)
        add("grid", `row ${y} has ${r.length} cells, expected ${fw}`, `make every row exactly ${fw} cells`, f);
      const bad = new Set([...r].filter((ch) => ch !== "." && !palette.colours[ch]));
      if (r.includes("#")) add("legend", `row ${y} uses "#"`, 'never use "#"; "." is transparent', f);
      bad.delete("#");
      if (bad.size)
        add(
          "legend",
          `row ${y} uses letters not in the palette: ${[...bad].join("")}`,
          "use only palette letters and . for transparent",
          f,
        );
    });
  }
  if (hard.some((i) => i.rule === "grid" || i.rule === "legend" || i.rule === "shape"))
    return { ok: false, hard, soft, stats };
  // feet on the bottom row (characters, except jump/fall poses)
  if (a.kind === "character")
    for (const [f, rows] of Object.entries(a.grid))
      if (!/^(jump|fall)/.test(f) && !/[^.]/.test(rows[rows.length - 1] ?? ""))
        add("feet", "feet do not touch the bottom row", "move the figure down so its feet sit on the last row", f);
  // orphan pixels
  if (a.kind !== "font")
    for (const [f, rows] of Object.entries(a.grid)) {
      const o = orphans(rows);
      if (o.length)
        add(
          "orphans",
          `${o.length} orphan pixel(s), first at ${o[0].join(",")}`,
          "remove single pixels with no neighbour, or connect them",
          f,
        );
    }
  // frame-to-frame swap cap on loops (a creature's move and perch cycles too)
  if (a.kind === "character" || a.kind === "creature") {
    const loops = [
      ["idle0", "idle1"],
      ["run0", "run1", "run2", "run3"],
      ["move0", "move1", "move2", "move3"],
      ["perch0", "perch1"],
    ].map((l) => l.filter((f) => a.grid[f]));
    for (const loop of loops) {
      if (loop.length < 2) continue;
      const cap = Math.round(SWAP_CAP * opaque(a.grid[loop[0]]));
      loop.forEach((f, i) => {
        const g = loop[(i + 1) % loop.length];
        if (loop.length === 2 && i === 1) return;
        const n = diff(a.grid[f], a.grid[g]);
        stats[`swap:${f}>${g}`] = n;
        if (n > cap)
          add(
            "swap",
            `${f} -> ${g} repaints ${n} cells (cap ${cap})`,
            "change less between loop frames so it does not flicker",
            f,
          );
      });
    }
  }
  // edge contrast on the night sky
  if (ON_SKY.has(a.kind))
    for (const [f, rows] of Object.entries(a.grid)) {
      const c = silhouetteContrast(rows, palette.colours, palette.sky);
      stats[`edge:${f}`] = Math.round(c.ratio * 100) / 100;
      if (c.edges && c.ratio < EDGE_PASS)
        add(
          "contrast",
          `only ${Math.round(c.ratio * 100)}% of the silhouette edge reaches ${EDGE_MIN}:1 on the sky`,
          `lighten the outer ring inside the outline so at least ${EDGE_PASS * 100}% of it reads at night`,
          f,
        );
      else if (c.edges && c.ratio < 0.6)
        soft.push(`${f}: the silhouette edge is dim on the sky (${Math.round(c.ratio * 100)}%); check it reads at 1x.`);
    }
  // notes for the vision reviewer
  soft.push(`Reads as a ${a.kind}${a.description ? ` (${a.description})` : ""} at 1x on the night sky.`);
  soft.push("Light comes from the upper left: right and bottom edges take the darker tone.");
  if (a.kind === "character") {
    soft.push("Feet planted on the bottom row; the head and hands read in idle and run.");
    if (a.grid.run0) soft.push("Run cycle alternates contact and passing poses; no frame pops.");
    if (a.tags.includes("hero"))
      soft.push(
        "Its facing field says which way the art looks (drawn heroes face right); the engine turns it to its walk.",
      );
  }
  if (a.kind === "tile" || a.kind === "backdrop") soft.push("Tiles seamlessly left to right.");
  if (a.palette.split("@")[0] !== "pap-night")
    soft.push(`Palette ${a.palette}: check it matches the project's palette.`);
  return { ok: !hard.length, hard, soft, stats };
}
