// Validation shared by decl.ts and recipes.ts: closed prop specs, cue-anchored times, errors that carry a fix.
// Pure: runs inside the render sandbox's import graph.
import { type PSpec, SFX_TYPES, type Spec } from "./decl-spec.ts";

export type DeclIssue = { path: string; message: string; fix: string };
export class DeclError extends Error {
  readonly issues: DeclIssue[];
  readonly path: string;
  readonly fix: string;
  constructor(issues: DeclIssue[]) {
    const first = issues[0];
    super(`${first.path}: ${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`);
    this.issues = issues;
    this.path = first.path;
    this.fix = first.fix;
  }
}

export type At = (e: string | number) => number;
const SFX = new Set<string>(SFX_TYPES);
const isColour = (v: unknown) => typeof v === "string" && (/^[A-Za-z]$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v));

// ---------------------------------------------------------------- validation
/** check one value against its spec; returns the cleaned value (times resolved to seconds) */
function checkValue(path: string, s: PSpec, v: unknown, issues: DeclIssue[], at: At): unknown {
  const bad = (message: string, fix: string) => {
    issues.push({ path, message, fix });
    return s.d;
  };
  switch (s.t) {
    case "num":
    case "int": {
      const n = typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n))
        return bad(
          `expected a number, got ${JSON.stringify(v)}`,
          `write a plain number${s.min !== undefined ? ` from ${s.min} to ${s.max}` : ""}`,
        );
      if (s.t === "int" && !Number.isInteger(n))
        return bad(`expected a whole number, got ${n}`, `use ${Math.round(n)}`);
      if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max))
        return bad(`${n} is out of range`, `use a value from ${s.min} to ${s.max}`);
      return n;
    }
    case "str":
      if (typeof v !== "string")
        return bad(`expected text, got ${JSON.stringify(v)}`, 'write it in quotes, e.g. "STAR"');
      return v;
    case "bool":
      if (typeof v !== "boolean")
        return bad(`expected true or false, got ${JSON.stringify(v)}`, "use true or false without quotes");
      return v;
    case "colour":
      if (v === null) return null;
      if (!isColour(v))
        return bad(
          `expected a palette letter or #rrggbb, got ${JSON.stringify(v)}`,
          'use a palette letter such as "P", "B", "T" or "O"',
        );
      return v;
    case "enum":
      if (typeof v !== "string" || !s.of!.includes(v))
        return bad(`${JSON.stringify(v)} is not allowed`, `use one of: ${s.of!.join(", ")}`);
      return v;
    case "sfx":
      if (v === null || v === false) return null;
      if (typeof v !== "string" || !SFX.has(v))
        return bad(`unknown sound ${JSON.stringify(v)}`, `use one of: ${SFX_TYPES.join(", ")}, or null for none`);
      return v;
    case "time":
      return timeOf(path, v, issues, at);
    case "times":
      if (!Array.isArray(v)) return bad("expected a list of times", 'e.g. ["S(c01)+0.2", "E(c01)"]');
      return v.map((x, i) => timeOf(`${path}[${i}]`, x, issues, at));
    case "strs":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        return bad("expected a list of names", 'e.g. ["flag0", "flag1"]');
      return v;
    case "list":
      if (!Array.isArray(v)) return bad("expected a list", "write it as [ ... ]");
      return v;
    case "obj":
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad("expected an object", "write it as { ... }");
      return v;
  }
}

export function timeOf(path: string, v: unknown, issues: DeclIssue[], at: At): number {
  if (typeof v !== "string" && typeof v !== "number") {
    issues.push({
      path,
      message: `expected a time, got ${JSON.stringify(v)}`,
      fix: 'anchor it to a cue, e.g. "S(c01)+0.3"',
    });
    return 0;
  }
  try {
    const n = at(v);
    if (!Number.isFinite(n)) throw new Error(`${v} is not a finite time`);
    return n;
  } catch (e: any) {
    issues.push({
      path,
      message: String(e?.message ?? e),
      fix: e?.fix ?? 'use S(cue), E(cue), @event or <scene>.from, e.g. "S(c01)+0.3"',
    });
    return 0;
  }
}

/** validate a props object against a spec; unknown props are errors (the menu is closed) */
export function checkSpec(
  path: string,
  spec: Spec,
  input: Record<string, unknown> | undefined,
  issues: DeclIssue[],
  at: At,
): Record<string, any> {
  const out: Record<string, any> = {};
  const src = input ?? {};
  for (const k of Object.keys(src)) {
    if (!(k in spec)) {
      const near = Object.keys(spec).find((n) => n.toLowerCase() === k.toLowerCase());
      issues.push({
        path: `${path}.${k}`,
        message: `unknown prop "${k}"`,
        fix: near ? `did you mean "${near}"?` : `allowed: ${Object.keys(spec).join(", ")}`,
      });
    }
  }
  for (const [k, s] of Object.entries(spec)) {
    const v = src[k];
    if (v === undefined) {
      if (s.req)
        issues.push({ path: `${path}.${k}`, message: `missing required prop "${k}"`, fix: `add "${k}": ${s.doc}` });
      else if (s.d !== undefined) out[k] = s.d;
      continue;
    }
    out[k] = checkValue(`${path}.${k}`, s, v, issues, at);
  }
  return out;
}
