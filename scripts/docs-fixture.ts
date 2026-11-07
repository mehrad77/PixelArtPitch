// Writes apps/web/src/mock/docs-tools.json for the Docs page's mock: the tool list (GET /api/docs/tools), taken from
// the real registry with the crew's and Pip's tools wired in, and the listing entries of the docs the mock opens
// (MOCK_DOCS; their text comes from the files themselves). Run it after adding or changing a tool:
//   node scripts/docs-fixture.ts && pnpm exec biome format --write apps/web/src/mock/docs-tools.json
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pap-fixture-"));
process.env.PAP_HOME = home;
const { buildRegistry, Workspace } = await import("../packages/tools/src/index.ts");
const { listDocs, REPO_ROOT, toolDocs } = await import("../apps/server/src/docs.ts");
/** keep in step with RAW in apps/web/src/mock/docs.ts */
const MOCK_DOCS = [
  "README.md",
  "AGENTS.md",
  "docs/GLOSSARY.md",
  "docs/STYLE-GUIDE.md",
  "docs/roles/writer.md",
  "docs/roles/reviewer.md",
  "skills/pap-writer/SKILL.md",
];
const { wireCrew } = await import("../apps/server/src/wire.ts");

const registry = buildRegistry();
const wired = await wireCrew({ workspace: new Workspace(() => []), registry, resume: false });
const out = new URL("../apps/web/src/mock/docs-tools.json", import.meta.url).pathname;
writeFileSync(
  out,
  `${JSON.stringify(
    { docs: listDocs(REPO_ROOT).filter((d) => MOCK_DOCS.includes(d.path)), tools: toolDocs(registry) },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${registry.list().length} tools to ${out}`);
wired.connections.closeAll();
rmSync(home, { recursive: true, force: true });
process.exit(0);
