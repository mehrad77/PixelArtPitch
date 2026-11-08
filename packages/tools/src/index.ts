import { ASSIST_TOOLS } from "./assist.ts";
import { CORE_TOOLS } from "./defs.ts";
import { Registry } from "./registry.ts";

export * from "./align.ts";
export * from "./assist.ts";
export * from "./defs.ts";
export * from "./drafts.ts";
export * from "./registry.ts";
export * from "./store.ts";
export * from "./words.ts";

/** the registry with every built-in tool; the crew and the server add their own */
export function buildRegistry() {
  return new Registry().add(...CORE_TOOLS, ...ASSIST_TOOLS);
}
