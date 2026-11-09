import { ASSIST_TOOLS } from "./assist.ts";
import { CORE_TOOLS } from "./defs.ts";
import { EDIT_TOOLS } from "./edits.ts";
import { Registry } from "./registry.ts";

export * from "./align.ts";
export * from "./assist.ts";
export * from "./constants.ts";
export * from "./defs.ts";
export * from "./drafts.ts";
export * from "./edits.ts";
export * from "./parts.ts";
export * from "./registry.ts";
export * from "./store.ts";
export * from "./studio.ts";
export * from "./words.ts";

/** the registry with every built-in tool; the crew and the server add their own */
export function buildRegistry() {
  return new Registry().add(...CORE_TOOLS, ...ASSIST_TOOLS, ...EDIT_TOOLS);
}
