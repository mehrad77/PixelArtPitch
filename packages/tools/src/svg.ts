// SVG references (a logo exported as SVG): rasterised once to a 512 px PNG with transparency, with @resvg/resvg-js
// (prebuilt, no system libraries). The .svg stays the source; the PNG is what the logo import and vision read.
import { Resvg } from "@resvg/resvg-js";

export const SVG_RASTER = 512;

/** the bytes look like an SVG document (an XML prolog or comment, then an <svg> root) */
export function isSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("utf8").replace(/^﻿/, "");
  return /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head);
}

/** an SVG drawn to a size x size PNG (aspect kept, the longer side at `size`, transparent background) */
export function rasterizeSvg(svg: Uint8Array | string, size = SVG_RASTER): Uint8Array {
  const r = new Resvg(typeof svg === "string" ? svg : Buffer.from(svg), {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
    font: { loadSystemFonts: false },
  });
  // a tall drawing fits the height instead
  const tall = r.height > r.width;
  const out = tall
    ? new Resvg(typeof svg === "string" ? svg : Buffer.from(svg), {
        fitTo: { mode: "height", value: size },
        background: "rgba(0,0,0,0)",
        font: { loadSystemFonts: false },
      }).render()
    : r.render();
  return new Uint8Array(out.asPng());
}
