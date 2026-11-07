// pap report: a project's run as one HTML page (docs/REPORT.md).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderHtml } from "./html.ts";
import { type ReportOptions, type Summary, summarize } from "./summarize.ts";

export { renderHtml } from "./html.ts";
export { errorKind, FAIL_KINDS, FAIL_LABEL, type FailKind } from "./kinds.ts";
export { type ReportOptions, redact, type Summary, summarize } from "./summarize.ts";

export type ReportImage = { name: string; data: Uint8Array };
export type Report = { html: string; summary: Summary; images: ReportImage[] };

/**
 * The report for the project in `projectDir`. With `out`, it also writes `<out>/index.html` and `<out>/img/*` and
 * returns the same. The page names its images as `img/<file>.png`, relative to itself.
 */
export function buildReport(projectDir: string, opts: ReportOptions & { out?: string } = {}): Report {
  const dir = resolve(projectDir);
  const { summary, images } = summarize(dir, opts);
  const html = renderHtml(summary);
  const imgs = images.map((i) => ({ name: i.name, data: readFileSync(i.src) }));
  if (opts.out) {
    const out = resolve(opts.out);
    mkdirSync(join(out, "img"), { recursive: true });
    writeFileSync(join(out, "index.html"), html);
    for (const i of images) {
      mkdirSync(dirname(join(out, i.name)), { recursive: true });
      copyFileSync(i.src, join(out, i.name));
    }
  }
  return { html, summary, images: imgs };
}
