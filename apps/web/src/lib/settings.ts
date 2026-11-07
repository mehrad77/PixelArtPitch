// Settings saves are partial: the Defaults form sends only its own fields. The nested objects merge field by field (as
// the server's `PUT /api/settings` does), so a save never resets what the form doesn't show; records and lists are
// replaced whole.
import type { Settings } from "./types.ts";

export function mergeSettings(cur: Settings, patch: Partial<Settings>): Settings {
  return {
    ...cur,
    ...patch,
    defaults: { ...cur.defaults, ...(patch.defaults ?? {}) },
    paths: { ...cur.paths, ...(patch.paths ?? {}) },
  };
}
