// JSON schema clean-up for native structured output. There is no SDK to strip what the grammar compilers reject, so we do
// it here and let zod check the dropped constraints afterwards.
// Anthropic (claude-api/shared/tool-use-concepts.md, "JSON Schema Limitations"): no numerical or string length
// constraints, no complex array constraints, `additionalProperties` must be false on every object, no recursion.
// OpenAI strict mode additionally wants every property listed in `required`.
import { z } from "zod";

const DROP = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "propertyNames",
  "minProperties",
  "maxProperties",
]);

export type SanitizedSchema = {
  schema: Record<string, unknown>;
  /** false when the schema needs something native structured output cannot express (records, recursion) */
  nativeOk: boolean;
  /** true when every object lists all of its properties as required (OpenAI `strict: true`) */
  strictOk: boolean;
  /** number of properties across all objects (huge per-item schemas break grammar compilers) */
  properties: number;
};

export function sanitizeSchema(input: Record<string, unknown>): SanitizedSchema {
  let nativeOk = true;
  let strictOk = true;
  let properties = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (DROP.has(k)) continue;
      if (k === "minItems" && typeof v === "number" && v > 1) continue;
      if (k === "$ref" && v === "#") nativeOk = false;
      if ((k === "properties" || k === "$defs" || k === "definitions") && v && typeof v === "object") {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)]));
        continue;
      }
      out[k] = walk(v);
    }
    const isObject = src.type === "object" || (src.properties && typeof src.properties === "object");
    if (isObject) {
      const ap = src.additionalProperties;
      if (ap && typeof ap === "object") nativeOk = false; // a record: native output can only say false
      out.additionalProperties = false;
      const keys = Object.keys((src.properties as object) ?? {});
      properties += keys.length;
      const req = new Set((src.required as string[]) ?? []);
      if (keys.some((k) => !req.has(k))) strictOk = false;
    }
    return out;
  };
  const schema = walk(input) as Record<string, unknown>;
  return { schema, nativeOk, strictOk, properties };
}

/** zod 4 -> JSON schema (draft 2020-12, input side so defaults stay optional). */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
