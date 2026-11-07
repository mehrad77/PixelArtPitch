// asset.import (docs/PIP-ORCHESTRATION.md §1.1, RIGHTS.md §3): a logo the person supplied is quantized to the palette as
// a 16x16 icon, never drawn by a model. A small PNG reader (8-bit greyscale, RGB, palette or RGBA, not interlaced) and a
// box downscale; other formats come back with a fix.
import { inflateSync } from "node:zlib";
import { quantize } from "@pap/engine/quantize";

export type Rgba = { w: number; h: number; data: Uint8Array };

const fail = (message: string, fix: string) => Object.assign(new Error(message), { fix, code: "bad_image" });

/** decode a PNG into RGBA */
export function decodePng(buf: Uint8Array): Rgba {
  const b = Buffer.from(buf);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47)
    throw fail("the reference is not a PNG", "export the logo as a PNG (8-bit, not interlaced) and add it again");
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const kind = b.toString("latin1", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "PLTE") plte = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!w || !h || depth !== 8 || !channels || interlace)
    throw fail(
      `unsupported PNG (bit depth ${depth}, colour type ${type}${interlace ? ", interlaced" : ""})`,
      "export the logo as an 8-bit RGBA PNG, not interlaced",
    );
  if (w * h > 4096 * 4096) throw fail("the logo image is too large", "use an image of at most 4096x4096 pixels");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const up = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    let r = 0;
    let g = 0;
    let bl = 0;
    let al = 255;
    if (type === 0) r = g = bl = px[s];
    else if (type === 4) {
      r = g = bl = px[s];
      al = px[s + 1];
    } else if (type === 2) [r, g, bl] = [px[s], px[s + 1], px[s + 2]];
    else if (type === 6) [r, g, bl, al] = [px[s], px[s + 1], px[s + 2], px[s + 3]];
    else {
      const k = px[s];
      if (!plte || k * 3 + 2 >= plte.length)
        throw fail("the PNG's palette is broken", "export the logo as an RGBA PNG");
      [r, g, bl] = [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2]];
      al = trns && k < trns.length ? trns[k] : 255;
    }
    out.set([r, g, bl, al], i * 4);
  }
  return { w, h, data: out };
}

/** fit the image into size x size (aspect kept, centred), averaging the source pixels under each cell */
export function boxDownscale(img: Rgba, size: number): Rgba {
  const s = Math.max(img.w, img.h) / size;
  const ow = Math.max(1, Math.round(img.w / s));
  const oh = Math.max(1, Math.round(img.h / s));
  const ox = Math.floor((size - ow) / 2);
  const oy = Math.floor((size - oh) / 2);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * s);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * s));
      const y0 = Math.floor(y * s);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let j = y0; j < Math.min(y1, img.h); j++)
        for (let i = x0; i < Math.min(x1, img.w); i++) {
          const o = (j * img.w + i) * 4;
          const al = img.data[o + 3];
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
          n++;
        }
      const o = ((oy + y) * size + ox + x) * 4;
      if (a) data.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)], o);
    }
  return { w: size, h: size, data };
}

/** a logo PNG -> a 16x16 icon's letter rows in the palette */
export function logoIcon(png: Uint8Array, colours: Record<string, string>) {
  const small = boxDownscale(decodePng(png), 16);
  return quantize(small, colours);
}
