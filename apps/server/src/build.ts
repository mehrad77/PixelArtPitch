// Is the studio UI the server hands out older than its source? `pap serve` warns (and `--build` rebuilds first), and
// GET /api/build tells the page, which shows "This studio is running an old build".
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type BuildInfo = { webStale: boolean; builtAt: string | null; srcAt: string | null };

/** the newest mtime under `dir` (files only), or 0 */
function newest(dir: string): number {
  if (!existsSync(dir)) return 0;
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const f = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(f) : statSync(f).mtimeMs);
  }
  return t;
}

/**
 * `apps/web/dist/index.html`'s time against the newest file in `apps/web/src`. Stale when the build is older, or
 * missing while the source is there. With no source (an installed build) nothing is stale.
 */
export function webBuild(webDir: string): BuildInfo {
  const index = join(webDir, "dist", "index.html");
  const built = existsSync(index) ? statSync(index).mtimeMs : 0;
  const src = newest(join(webDir, "src"));
  const iso = (t: number) => (t ? new Date(t).toISOString() : null);
  return { webStale: src > 0 && built < src, builtAt: iso(built), srcAt: iso(src) };
}
