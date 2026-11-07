// Shared harness for the authored library assets: palette, grid helpers, asset writer (with the PAP checker and the
// extra checks the brief asks for), and contact sheets. Everything is written under ../ (the libdraw scratch folder).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAsset, silhouetteContrast } from "../../packages/engine/src/standard.ts";
import { diffCount, encodePng, Grid, parseHex, renderSheet } from "../../vendor/painter/index.mjs";

export * from "../../vendor/painter/index.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** where assets, sheets and previews are written (gitignored); set OUT to change it */
export const OUT = process.env.OUT ?? join(REPO, "out/library-pack");
const pal = JSON.parse(readFileSync(`${REPO}/library/palettes/pap-night.json`, "utf8"));
export const SKY = pal.sky;
export const COLOURS = Object.fromEntries(Object.entries(pal.colours).map(([k, v]) => [k, v.hex]));
export const PALETTE = { colours: COLOURS, sky: SKY };
const FONT = JSON.parse(readFileSync(`${REPO}/library/font-5x8/asset.json`, "utf8")).grid;

// ---------- grid helpers ----------

/** rows from a template literal: one row per non-empty line, whitespace stripped */
export const R = (s) =>
  (Array.isArray(s) ? s.join("") : s)
    .split("\n")
    .map((l) => l.replace(/\s+/g, ""))
    .filter(Boolean);

/** pad/centre rows into a w x h frame; anchor "bottom" | "center" */
export function fit(rows, w, h, { anchor = "center", dx = 0, dy = 0 } = {}) {
  const rw = Math.max(...rows.map((r) => r.length));
  const rh = rows.length;
  const g = new Grid(w, h);
  const x = Math.floor((w - rw) / 2) + dx;
  const y = (anchor === "bottom" ? h - rh : Math.floor((h - rh) / 2)) + dy;
  g.overlay(
    rows.map((r) => r.padEnd(rw, ".")),
    x,
    y,
  );
  return g.rows();
}

/** add a k outline around every opaque cell (4 neighbours by default, 8 for a rounder look) */
export function ol(rows, { n8 = false, ink = "k" } = {}) {
  const g = Grid.from(rows);
  const snap = g.snapshot();
  const at = (x, y) => snap[y]?.[x] ?? ".";
  const nb = n8
    ? [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]
    : [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      if (snap[y][x] === "." && nb.some(([dx, dy]) => at(x + dx, y + dy) !== "." && at(x + dx, y + dy) !== ink))
        g.set(x, y, ink);
  return g.rows();
}

/** replace letters: map {from: to} */
export const swap = (rows, map) => rows.map((r) => [...r].map((c) => map[c] ?? c).join(""));
export const flipX = (rows) => rows.map((r) => [...r].reverse().join(""));
export const shiftY = (rows, dy) => Grid.from(rows).shiftY(dy).rows();
export function shiftX(rows, dx) {
  return rows.map((r) => (dx > 0 ? ".".repeat(dx) + r.slice(0, r.length - dx) : r.slice(-dx) + ".".repeat(-dx)));
}
/** paste rows on top of base at (x,y), transparent cells kept */
export function paste(base, rows, x = 0, y = 0) {
  return Grid.from(base).overlay(rows, x, y).rows();
}
export const blank = (w, h) => new Grid(w, h).rows();

// ---------- checks ----------

const opaque = (rows) => rows.join("").replace(/\./g, "").length;

/** compare the opacity/letters at the joined edges. Returns the share of matching cells (1 = identical). */
function edgeMatch(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i++) if ((a[i] === ".") === (b[i] === ".")) same++;
  return same / a.length;
}

const col = (rows, x) => rows.map((r) => r[x]).join("");

// ---------- writing an asset ----------

export const ALL = []; // every asset written this run: { asset, wave, preview }

/**
 * Write assets/<id>/asset.json and sheet.png. Throws when checkAsset fails (the harness refuses to write).
 * opts: { id, kind, w, h, frames: {name: rows}, tags, description, recipe, wave,
 *         loops: [[names...]], tile: "lr" | "all" | null, seams: [[top, fill]], note }
 */
export function asset(o) {
  const names = Object.keys(o.frames);
  const doc = {
    id: o.id,
    version: 1,
    kind: o.kind,
    w: o.w,
    h: o.h,
    frames: names,
    palette: "pap-night@1",
    tags: o.tags,
    description: o.description,
    licence: "LicenseRef-PAP-Library",
    rights: { likeness: false, brand: false, trademark: false, public: true },
    provenance: {
      source: "authored",
      by: "claude-code",
      method: "code recipe",
      recipe: `scripts/library-pack/${o.recipe}`,
      role: "pixel-artist",
      origin: "common library pack, authored in code (2026-11-08)",
      sourceAssets: [],
      judgeReason: o.judge ?? null,
    },
    hash: "",
    standard: null,
    grid: o.frames,
  };
  doc.hash = createHash("sha256").update(JSON.stringify(doc.grid)).digest("hex").slice(0, 16);
  const res = checkAsset(doc, PALETTE);
  // extra stats the brief asks for
  const extra = {};
  const problems = [];
  if (["character", "crowd", "prop", "icon", "block", "decor", "logo"].includes(o.kind))
    for (const n of names) {
      const c = silhouetteContrast(o.frames[n], COLOURS, COLOURS.K);
      extra[`edgeK:${n}`] = Math.round(c.ratio * 100) / 100;
      if (c.edges && c.ratio < 0.4) problems.push(`${n}: edge vs ink-3 K only ${Math.round(c.ratio * 100)}%`);
    }
  for (const loop of o.loops ?? []) {
    const cap = Math.round(0.5 * opaque(o.frames[loop[0]]));
    loop.forEach((f, i) => {
      if (loop.length === 2 && i === 1) return;
      const g = loop[(i + 1) % loop.length];
      const n = diffCount(o.frames[f], o.frames[g]);
      extra[`swap:${f}>${g}`] = n;
      extra[`swapcap:${f}>${g}`] = cap;
      if (n > cap && !o.swapExempt) problems.push(`swap ${f}->${g} ${n} > cap ${cap}`);
    });
  }
  if (o.tile)
    for (const n of o.tileFrames ?? names) {
      const rows = o.frames[n];
      const lr = edgeMatch(col(rows, 0), col(rows, o.w - 1));
      extra[`seamLR:${n}`] = Math.round(lr * 100) / 100;
      // a surface may step by one cell across the seam (a wave or a slope); more than that is a visible break
      if (lr < 1 - 1.5 / o.h) problems.push(`${n}: left/right edge opacity differs`);
      if (o.tile === "all") {
        // opaque on both top and bottom rows
        const tb = edgeMatch(rows[0], rows[o.h - 1]);
        extra[`seamTB:${n}`] = Math.round(tb * 100) / 100;
        if (tb < 1 - 1.5 / o.w) problems.push(`${n}: top/bottom edge opacity differs`);
      }
    }
  for (const [top, fill] of o.seams ?? []) {
    const a = o.frames[top][o.h - 1];
    const b = o.frames[fill][0];
    extra[`seamV:${top}/${fill}`] = edgeMatch(a, b);
  }
  if (!res.ok || problems.length) {
    console.error(`REFUSED ${o.id}:`, JSON.stringify(res.hard, null, 1), problems);
    throw new Error(`asset ${o.id} failed`);
  }
  doc.standard = { ...res, stats: { ...res.stats, ...extra } };
  const dir = join(OUT, "assets", o.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "asset.json"), `${JSON.stringify(doc, null, 1)}\n`);
  const scale = o.w > 48 ? 5 : 10;
  writeFileSync(
    join(dir, "sheet.png"),
    renderSheet(
      names.map((n) => o.frames[n]),
      { colours: COLOURS, scale, columns: 4, bg: SKY },
    ),
  );
  ALL.push({
    doc,
    wave: o.wave,
    tile: o.tile,
    tileFrames: o.tileFrames,
    seams: o.seams,
    compose: o.compose,
    note: o.note,
  });
  return doc;
}

// ---------- contact sheets ----------

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  rect(x, y, w, h, hex) {
    const [r, g, b] = parseHex(hex);
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const k = (j * this.w + i) * 3;
        this.px[k] = r;
        this.px[k + 1] = g;
        this.px[k + 2] = b;
      }
  }
  blit(rows, x, y, s) {
    rows.forEach((row, j) => {
      [...row].forEach((c, i) => {
        if (c !== ".") this.rect(x + i * s, y + j * s, s, s, COLOURS[c] ?? "#ff00ff");
      });
    });
  }
  text(str, x, y, s, hex = "#e6e4da") {
    let cx = x;
    for (const ch of str) {
      const g = FONT[`g${ch.codePointAt(0)}`];
      if (g)
        g.forEach((row, j) => {
          [...row].forEach((c, i) => {
            if (c !== ".") this.rect(cx + i * s, y + j * s, s, s, hex);
          });
        });
      cx += 6 * s;
    }
  }
  png() {
    return encodePng(this.w, this.h, this.px);
  }
}

/** one contact sheet per wave: every asset with its id, frames at `scale` on the sky, a 1x/2x strip on K, and tiled previews */
export function contactSheet(wave, { scale = 5, width = 1800 } = {}) {
  const list = ALL.filter((a) => a.wave === wave);
  // layout pass then paint pass
  const layout = (paint) => {
    let y = 16;
    for (const { doc, tile, tileFrames, seams, compose } of list) {
      if (paint) paint.text(`${doc.id}  ${doc.kind} ${doc.w}x${doc.h}  ${doc.frames.length}f`, 16, y, 3, "#6cbf8e");
      y += 8 * 3 + 10;
      let x = 16;
      let rowH = 0;
      const fw = doc.w * scale;
      const fh = doc.h * scale;
      for (const f of doc.frames) {
        const label = f;
        const cw = Math.max(fw, label.length * 12) + 16;
        if (x + cw > width - 16) {
          x = 16;
          y += rowH;
          rowH = 0;
        }
        if (paint) {
          paint.rect(x - 2, y - 2, fw + 4, fh + 4, "#161d18");
          paint.rect(x, y, fw, fh, SKY);
          paint.blit(doc.grid[f], x, y, scale);
          paint.text(label, x, y + fh + 6, 2, "#9a9d93");
        }
        x += cw;
        rowH = Math.max(rowH, fh + 30);
      }
      y += rowH;
      // 1x and 2x strip on the ink-3 ground tone
      let sx = 16;
      const sh = doc.h * 2 + 8;
      if (paint) paint.rect(8, y, width - 16, sh, "#161d18");
      for (const f of doc.frames) {
        if (sx + doc.w * 3 + 8 > width - 16) break;
        if (paint) {
          paint.blit(doc.grid[f], sx, y + 4, 1);
          paint.blit(doc.grid[f], sx + doc.w + 4, y + 4, 2);
        }
        sx += doc.w * 3 + 14;
      }
      y += sh + 8;
      // stacked previews: a surface tile over its fill (or any custom arrangement: compose = [[frame names per row]])
      const stacks =
        compose ??
        (seams ?? []).map(([t, f]) => [
          [t, t, t, t],
          [f, f, f, f],
          [f, f, f, f],
        ]);
      if (stacks.length) {
        let tx = 16;
        let th = 0;
        const ts = 3;
        for (const st of stacks) {
          const tw = Math.max(...st.map((r) => r.length)) * doc.w * ts;
          if (tx + tw > width - 16) {
            tx = 16;
            y += th + 10;
            th = 0;
          }
          if (paint)
            st.forEach((r, j) => {
              r.forEach((f, i) => {
                if (f) paint.blit(doc.grid[f], tx + i * doc.w * ts, y + j * doc.h * ts, ts);
              });
            });
          tx += tw + 12;
          th = Math.max(th, st.length * doc.h * ts);
        }
        y += th + 12;
      }
      // tiled previews
      if (tile && !seams) {
        let tx = 16;
        const ts = doc.kind === "backdrop" ? 2 : 3;
        const nx = doc.kind === "backdrop" ? 3 : 4;
        const ny = tile === "all" ? 3 : 1;
        let th = 0;
        for (const f of tileFrames ?? doc.frames) {
          const tw = doc.w * ts * nx;
          if (tx + tw > width - 16) {
            tx = 16;
            y += th + 10;
            th = 0;
          }
          if (paint)
            for (let j = 0; j < ny; j++)
              for (let i = 0; i < nx; i++) paint.blit(doc.grid[f], tx + i * doc.w * ts, y + j * doc.h * ts, ts);
          tx += tw + 12;
          th = Math.max(th, doc.h * ts * ny);
        }
        y += th + 12;
      }
      y += 18;
    }
    return y;
  };
  const h = layout(null);
  const c = new Canvas(width, h, "#0b0f0d");
  layout(c);
  mkdirSync(join(OUT, "sheets"), { recursive: true });
  writeFileSync(join(OUT, "sheets", `${wave}.png`), c.png());
}

/** Render a quick zoomed preview of some frames for inspection (scale 6+). */
export function preview(file, frames, { scale = 6, columns = 6 } = {}) {
  mkdirSync(join(OUT, "preview"), { recursive: true });
  writeFileSync(
    join(OUT, "preview", file),
    renderSheet(frames, { colours: COLOURS, scale, columns, bg: [SKY, "#161d18"] }),
  );
}

export const recipeName = (url) => basename(fileURLToPath(url));

/**
 * A shaded ellipse ("lump"), painted onto grid g: light from the upper left. tones = [hi, body, lo, dark] (dark may
 * be omitted). Lumps painted later sit in front, so leafy canopies and clouds are built back to front.
 */
export function lump(g, cx, cy, rx, ry, tones, { cut = null } = {}) {
  const [hi, body, lo, dark = lo] = tones;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const u = (x + 0.5 - cx) / rx;
      const v = (y + 0.5 - cy) / ry;
      const d = u * u + v * v;
      if (d > 1) continue;
      if (cut && !cut(x, y)) continue;
      const s = (u + v) / Math.SQRT2;
      let c = body;
      if (s < -0.45 && d > 0.3) c = hi;
      else if (s > 0.7 && d > 0.55) c = dark;
      else if (s > 0.25) c = lo;
      g.set(x, y, c);
    }
  return g;
}

/** a drawn shape (no outline) -> padded by 1, k-outlined, placed in a w x h frame (bottom-anchored by default) */
export function sprite(src, w, h, { anchor = "bottom", n8 = false, dx = 0, dy = 0 } = {}) {
  const rows = typeof src === "string" ? R(src) : src;
  const rw = Math.max(...rows.map((r) => r.length));
  const padded = [".".repeat(rw + 2), ...rows.map((r) => `.${r.padEnd(rw, ".")}.`), ".".repeat(rw + 2)];
  let out = ol(padded, { n8 });
  // drop fully transparent border rows/cols left by the padding
  while (out.length && !/[^.]/.test(out[0])) out = out.slice(1);
  while (out.length && !/[^.]/.test(out[out.length - 1])) out = out.slice(0, -1);
  if (out.length > h || out[0].length > w + 2) throw new Error(`sprite ${out[0].length}x${out.length} > ${w}x${h}`);
  return fit(out, w, h, { anchor, dx, dy });
}

/**
 * Bevel one letter of a drawn shape: cells of `body` whose upper or left neighbour is outside the shape take `hi`;
 * cells whose lower or right neighbour is outside take `lo` (lo wins). `inside` lists letters that count as shape.
 */
export function bevel(rows, body, hi, lo, { inside = null } = {}) {
  const isIn = (c) => c !== "." && (!inside || inside.includes(c));
  return rows.map((r, y) =>
    [...r]
      .map((c, x) => {
        if (c !== body) return c;
        const up = isIn(rows[y - 1]?.[x] ?? ".");
        const left = isIn(r[x - 1] ?? ".");
        const down = isIn(rows[y + 1]?.[x] ?? ".");
        const right = isIn(r[x + 1] ?? ".");
        if (lo && (!down || !right)) return lo;
        if (hi && (!up || !left)) return hi;
        return c;
      })
      .join(""),
  );
}
