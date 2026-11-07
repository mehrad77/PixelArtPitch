// RFC 6902 JSON Patch with inverses, so every edit (by the user, an agent or an MCP client) can be undone by
// appending its inverse. Paths are RFC 6901 pointers ("/scenes/2/layers/0/props/x").
import { z } from "zod";

export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string() }),
  z.object({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("move"), from: z.string(), path: z.string() }),
  z.object({ op: z.literal("copy"), from: z.string(), path: z.string() }),
  z.object({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
]);
export type PatchOpT = z.infer<typeof PatchOp>;

export const Author = z.object({
  kind: z.enum(["user", "agent", "mcp", "system"]),
  role: z.string().optional(),
  model: z.string().optional(),
  task: z.string().optional(),
  client: z.string().optional(),
  /** who carried a person's action out for them: "pip" when the person confirmed one of Pip's cards */
  via: z.string().optional(),
});
export type AuthorT = z.infer<typeof Author>;

export const PatchEntry = z.object({
  seq: z.number().int(),
  opId: z.string(),
  ts: z.string(),
  baseRev: z.number().int(),
  author: Author,
  reason: z.string().max(500),
  ops: z.array(PatchOp),
  inverse: z.array(PatchOp),
  /** what this patch undoes, if it is an undo */
  undoes: z.number().int().optional(),
  note: z.string().optional(),
});
export type PatchEntryT = z.infer<typeof PatchEntry>;

export class PatchError extends Error {
  readonly path: string;
  readonly fix?: string;
  constructor(message: string, path: string, fix?: string) {
    super(message);
    this.path = path;
    this.fix = fix;
  }
}

export const parsePointer = (p: string): string[] => {
  if (p === "") return [];
  if (!p.startsWith("/")) throw new PatchError(`pointer must start with "/": ${p}`, p);
  return p
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
};
export const toPointer = (parts: (string | number)[]) =>
  parts.length ? `/${parts.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : "";

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function parentOf(doc: unknown, parts: string[], path: string): [any, string] {
  let cur: any = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur === null || typeof cur !== "object" || !(k in cur))
      throw new PatchError(`path does not exist: ${toPointer(parts.slice(0, i + 1))}`, path);
    cur = cur[k];
  }
  if (cur === null || typeof cur !== "object") throw new PatchError(`parent is not an object or array`, path);
  return [cur, parts[parts.length - 1]];
}

export function getAt(doc: unknown, path: string): unknown {
  let cur: any = doc;
  for (const k of parsePointer(path)) {
    if (cur === null || typeof cur !== "object" || !(k in cur))
      throw new PatchError(`path does not exist: ${path}`, path);
    cur = cur[k];
  }
  return cur;
}

const index = (arr: unknown[], k: string, path: string, forAdd: boolean) => {
  if (k === "-" && forAdd) return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(k)) throw new PatchError(`bad array index "${k}"`, path);
  const i = Number(k);
  if (i > arr.length || (!forAdd && i === arr.length)) throw new PatchError(`index ${i} out of range`, path);
  return i;
};

function applyOne(doc: any, op: PatchOpT): any {
  if (op.op === "test") {
    if (JSON.stringify(getAt(doc, op.path)) !== JSON.stringify(op.value)) throw new PatchError("test failed", op.path);
    return doc;
  }
  if (op.op === "move" || op.op === "copy") {
    const v = clone(getAt(doc, op.from));
    if (op.op === "move") {
      if (op.path.startsWith(`${op.from}/`)) throw new PatchError("cannot move into own child", op.path);
      doc = applyOne(doc, { op: "remove", path: op.from });
    }
    return applyOne(doc, { op: "add", path: op.path, value: v });
  }
  const parts = parsePointer(op.path);
  if (!parts.length) {
    if (op.op === "remove") throw new PatchError("cannot remove the root", op.path);
    return clone(op.value);
  }
  const [parent, key] = parentOf(doc, parts, op.path);
  if (Array.isArray(parent)) {
    const i = index(parent, key, op.path, op.op === "add");
    if (op.op === "add") parent.splice(i, 0, clone(op.value));
    else if (op.op === "remove") parent.splice(i, 1);
    else parent[i] = clone(op.value);
  } else {
    if (op.op !== "add" && !(key in parent)) throw new PatchError(`path does not exist: ${op.path}`, op.path);
    if (op.op === "remove") delete parent[key];
    else parent[key] = clone(op.value);
  }
  return doc;
}

function addInverse(before: unknown, path: string): PatchOpT {
  const parts = parsePointer(path);
  if (!parts.length) return { op: "replace", path: "", value: clone(before) };
  const [parent, key] = parentOf(before, parts, path);
  if (Array.isArray(parent))
    return { op: "remove", path: toPointer([...parts.slice(0, -1), index(parent, key, path, true)]) };
  if (key in parent) return { op: "replace", path, value: clone(parent[key]) };
  return { op: "remove", path };
}

/** Apply ops to a copy of doc. Returns the new doc and the inverse ops (apply them to the result to get doc back). */
export function applyPatch<T>(doc: T, ops: PatchOpT[]): { doc: T; inverse: PatchOpT[] } {
  let cur: any = structuredClone(doc);
  const inverse: PatchOpT[] = [];
  for (const op of ops) {
    const before = cur;
    switch (op.op) {
      case "add":
      case "copy":
        inverse.unshift(addInverse(before, op.path));
        break;
      case "remove":
        inverse.unshift({ op: "add", path: op.path, value: clone(getAt(before, op.path)) });
        break;
      case "replace":
        inverse.unshift({ op: "replace", path: op.path, value: clone(getAt(before, op.path)) });
        break;
      case "move":
        inverse.unshift({ op: "move", from: op.path, path: op.from });
        break;
      case "test":
        break;
    }
    cur = applyOne(cur, op);
  }
  return { doc: cur, inverse };
}

/** true when two patches touch overlapping paths (one is a prefix of the other) */
export function overlaps(a: PatchOpT[], b: PatchOpT[]): boolean {
  const paths = (ops: PatchOpT[]) => ops.flatMap((o) => ("from" in o ? [o.path, o.from] : [o.path]));
  const pa = paths(a);
  const pb = paths(b);
  return pa.some((x) =>
    pb.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || x === "" || y === ""),
  );
}

/** does `path` fall inside one of the allowed scopes (e.g. "/scenes/*\/layers", "/script/cues")? `*` matches one segment */
export function inScope(path: string, scopes: string[]): boolean {
  const p = parsePointer(path);
  return scopes.some((s) => {
    const q = parsePointer(s);
    if (q.length > p.length) return false;
    return q.every((seg, i) => seg === "*" || seg === p[i]);
  });
}
