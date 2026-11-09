// A code scene's named constants (docs/PIP-ORCHESTRATION.md §1.12): the `export const NAME = <literal>` lines at the
// top of a bundle that hold its positions, sizes, colour letters, beat offsets and hold lengths. Pip and the change
// classifier read them; code_set_constants edits them as text, with no model call.

/** a value a named constant may hold: a literal, or a flat list of literals */
export type ConstValue = number | string | boolean | (number | string | boolean)[];
export type NamedConst = { name: string; value: ConstValue; line: number };

const LINE =
  /^(\s*export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|[^;/\n]+?)(\s*;?\s*(?:\/\/.*)?)$/;

/** a literal's value (a number, a quoted string, true/false, or a flat list of those), or undefined for anything else */
export function literal(raw: string): ConstValue | undefined {
  const s = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (/^"(?:[^"\\]|\\.)*"$/.test(s) || /^'(?:[^'\\]|\\.)*'$/.test(s))
    try {
      return s.startsWith('"') ? JSON.parse(s) : JSON.parse(`"${s.slice(1, -1).replace(/"/g, '\\"')}"`);
    } catch {
      return undefined;
    }
  if (/^\[[^[\]{}()]*\]$/.test(s))
    try {
      const v = JSON.parse(s.replace(/'([^'\\]*)'/g, '"$1"').replace(/,\s*\]$/, "]"));
      if (Array.isArray(v) && v.every((x) => ["number", "string", "boolean"].includes(typeof x))) return v;
    } catch {}
  return undefined;
}

/** the bundle's named constants: `export const NAME = <literal>` lines, in order (an expression isn't one) */
export function constantsOf(source: string): NamedConst[] {
  const out: NamedConst[] = [];
  source.split("\n").forEach((l, line) => {
    const m = LINE.exec(l);
    if (!m) return;
    const value = literal(m[3]);
    if (value !== undefined) out.push({ name: m[2], value, line });
  });
  return out;
}

const kindOf = (v: ConstValue) => (Array.isArray(v) ? "list" : typeof v);
const write = (v: ConstValue): string =>
  Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v);

/**
 * The bundle with these constants set: only the literal after `=` changes, each to a value of the same kind. An
 * unknown name or a value of another kind fails with a fix that lists what exists.
 */
export function setConstants(
  source: string,
  set: Record<string, ConstValue>,
): { source: string; changed: { name: string; from: ConstValue; to: ConstValue }[] } | { error: string; fix: string } {
  const have = constantsOf(source);
  const byName = new Map(have.map((c) => [c.name, c]));
  const list = have.map((c) => `${c.name} = ${write(c.value)}`).join(", ");
  const lines = source.split("\n");
  const changed: { name: string; from: ConstValue; to: ConstValue }[] = [];
  for (const [name, to] of Object.entries(set)) {
    const c = byName.get(name);
    if (!c)
      return {
        error: `the scene has no named constant ${name}`,
        fix: have.length
          ? `use one of: ${list}`
          : "this scene has no named constants yet: ask the crew for the change (crew_request_change)",
      };
    if (kindOf(c.value) !== kindOf(to) || (typeof to === "number" && !Number.isFinite(to)))
      return {
        error: `${name} is a ${kindOf(c.value)}, not a ${kindOf(to)}`,
        fix: `give ${name} a ${kindOf(c.value)}`,
      };
    lines[c.line] = lines[c.line].replace(LINE, (_m, head, _n, _v, tail) => `${head}${write(to)}${tail}`);
    if (JSON.stringify(c.value) !== JSON.stringify(to)) changed.push({ name, from: c.value, to });
  }
  return { source: lines.join("\n"), changed };
}
