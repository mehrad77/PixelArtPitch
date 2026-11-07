// App settings at <appData>/settings.json (no secrets in it), crew profiles, and API keys.
// Keys: environment first, then the macOS Keychain (service "pixelartpitch", account = provider id), then a 0600 JSON
// file in appData. No getter meant for the UI returns a key (`hasKey` only), and keys are never logged.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleT } from "@pap/schema";
import { z } from "zod";
import { DEFAULT_BASE_URLS, isLocalProvider } from "./openai.ts";
import { appDataDir } from "./paths.ts";
import { modelsFor, ROLES } from "./roles.ts";
import type { ModelInfo, ProviderConfig, ProviderKind } from "./types.ts";

const ProviderKindZ = z.enum(["anthropic", "openai", "openrouter", "lmstudio", "ollama", "llamacpp", "custom"]);
const ProviderZ = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: ProviderKindZ,
  label: z.string(),
  baseUrl: z.string().url(),
  enabled: z.boolean(),
});
const RoleModelZ = z.object({ model: z.string(), fallback: z.string().optional() });
const PriceOverrideZ = z.object({
  inPerMTok: z.number().min(0),
  outPerMTok: z.number().min(0),
  cacheWritePerMTok: z.number().min(0).optional(),
  cacheReadPerMTok: z.number().min(0).optional(),
});

export const SettingsSchema = z.object({
  providers: z.array(ProviderZ),
  profile: z.enum(["best", "balanced", "local", "custom"]),
  roles: z.record(z.string(), RoleModelZ),
  defaults: z.object({
    capUsd: z.number().min(0),
    askAtFraction: z.number().min(0.1).max(1),
    involvement: z.enum(["every", "key", "auto"]),
    concurrency: z.number().int().min(1).max(32),
  }),
  paths: z.object({ roots: z.array(z.string()), library: z.string(), ffmpeg: z.string() }),
  /** manual $/MTok per model id, applied with setPriceOverride by the caller */
  prices: z.record(z.string(), PriceOverrideZ).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type Profile = Settings["profile"];
export type RoleAssignments = Record<RoleT, { model: string; fallback?: string }>;
/** What the UI gets: providers carry `hasKey`, never the key. */
export type PublicSettings = Omit<Settings, "providers"> & { providers: (ProviderConfig & { hasKey: boolean })[] };

export const settingsPath = (dir = appDataDir()) => join(dir, "settings.json");

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: "anthropic", kind: "anthropic", label: "Anthropic", baseUrl: DEFAULT_BASE_URLS.anthropic, enabled: true },
  { id: "openai", kind: "openai", label: "OpenAI", baseUrl: DEFAULT_BASE_URLS.openai, enabled: false },
  { id: "openrouter", kind: "openrouter", label: "OpenRouter", baseUrl: DEFAULT_BASE_URLS.openrouter, enabled: false },
  { id: "lmstudio", kind: "lmstudio", label: "LM Studio", baseUrl: DEFAULT_BASE_URLS.lmstudio, enabled: false },
  { id: "ollama", kind: "ollama", label: "Ollama", baseUrl: DEFAULT_BASE_URLS.ollama, enabled: false },
  { id: "llamacpp", kind: "llamacpp", label: "llama.cpp", baseUrl: DEFAULT_BASE_URLS.llamacpp, enabled: false },
];

const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const tier = (m: string) => ({ model: m, fallback: m === OPUS ? SONNET : m === SONNET ? OPUS : SONNET });

export const PROFILES: Record<"best" | "balanced", RoleAssignments> = {
  best: {
    director: tier(OPUS),
    "art-director": tier(OPUS),
    "pixel-artist": tier(OPUS),
    reviewer: tier(OPUS),
    "scene-coder": tier(OPUS),
    writer: tier(SONNET),
    animator: tier(SONNET),
    producer: tier(SONNET),
    librarian: tier(HAIKU),
    "sound-designer": tier(HAIKU),
    mixer: tier(HAIKU),
    editor: tier(HAIKU),
  },
  // mostly Sonnet; Opus only for reviewer and pixel-artist; the four light roles stay on Haiku as in Best
  balanced: {
    director: tier(SONNET),
    "art-director": tier(SONNET),
    "pixel-artist": tier(OPUS),
    reviewer: tier(OPUS),
    "scene-coder": tier(SONNET),
    writer: tier(SONNET),
    animator: tier(SONNET),
    producer: tier(SONNET),
    librarian: tier(HAIKU),
    "sound-designer": tier(HAIKU),
    mixer: tier(HAIKU),
    editor: tier(HAIKU),
  },
};

/**
 * Local profile: the first enabled local provider's models. Each role gets the first listed model that meets its
 * needs (falling back to the first model at all), and the second qualifying one as fallback.
 */
export function localProfile(providers: ProviderConfig[], models: ModelInfo[]): RoleAssignments | null {
  const p = providers.find((x) => x.enabled && isLocalProvider(x));
  if (!p) return null;
  const mine = models.filter((m) => m.provider === p.id);
  if (!mine.length) return null;
  const out = {} as RoleAssignments;
  for (const role of ROLES) {
    const fit = modelsFor(role, mine).shown;
    const model = (fit[0] ?? mine[0]).id;
    const fallback = fit.find((m) => m.id !== model)?.id;
    out[role] = fallback ? { model, fallback } : { model };
  }
  return out;
}

export function rolesForProfile(
  profile: Profile,
  ctx: { providers: ProviderConfig[]; models?: ModelInfo[]; current?: RoleAssignments },
): RoleAssignments | null {
  if (profile === "best" || profile === "balanced") return structuredClone(PROFILES[profile]);
  if (profile === "local") return localProfile(ctx.providers, ctx.models ?? []);
  return ctx.current ?? null;
}

export function defaultSettings(): Settings {
  const lib = join(appDataDir(), "library");
  return {
    providers: structuredClone(DEFAULT_PROVIDERS),
    profile: "best",
    roles: structuredClone(PROFILES.best),
    defaults: { capUsd: 20, askAtFraction: 0.8, involvement: "key", concurrency: 4 },
    paths: { roots: [join(appDataDir(), "projects")], library: lib, ffmpeg: "ffmpeg" },
    prices: {},
  };
}

export function loadSettings(dir = appDataDir()): Settings {
  const p = settingsPath(dir);
  if (!existsSync(p)) return defaultSettings();
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const base = defaultSettings();
  return SettingsSchema.parse({
    ...base,
    ...raw,
    defaults: { ...base.defaults, ...raw.defaults },
    paths: { ...base.paths, ...raw.paths },
  });
}

/** Validates, strips anything that looks like a key, writes atomically. */
export function saveSettings(s: Settings, dir = appDataDir()): void {
  const clean = SettingsSchema.parse(s);
  const p = settingsPath(dir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  renameSync(tmp, p);
}

export function publicSettings(s: Settings, secrets: SecretStore): PublicSettings {
  const clean = SettingsSchema.parse(s);
  return { ...clean, providers: clean.providers.map((p) => ({ ...p, hasKey: secrets.hasKey(p) })) };
}

// ---- secrets ----
export const ENV_KEYS: Partial<Record<ProviderKind, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
export const KEYCHAIN_SERVICE = "pixelartpitch";

export type ExecLike = (cmd: string, args: string[]) => string;
const realExec: ExecLike = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });

export type SecretStoreOpts = {
  env?: Record<string, string | undefined>;
  /** runs `security`; inject in tests */
  exec?: ExecLike;
  /** use the macOS Keychain (default: process.platform === "darwin") */
  keychain?: boolean;
  dir?: string;
};

export class SecretStore {
  private env: Record<string, string | undefined>;
  private exec: ExecLike;
  private keychain: boolean;
  private dir: string;
  /** keychain/file lookups, so chat calls don't spawn `security` each time; cleared by setKey/deleteKey */
  private stored = new Map<string, string | undefined>();
  constructor(opts: SecretStoreOpts = {}) {
    this.env = opts.env ?? process.env;
    this.exec = opts.exec ?? realExec;
    this.keychain = opts.keychain ?? process.platform === "darwin";
    this.dir = opts.dir ?? appDataDir();
  }

  private filePath() {
    return join(this.dir, "secrets.json");
  }
  private readFile(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.filePath(), "utf8"));
    } catch {
      return {};
    }
  }
  private writeFile(data: Record<string, string>) {
    const p = this.filePath();
    writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  /** For providers only (the HTTP clients). Never return this to the UI or a log. */
  getKey(p: Pick<ProviderConfig, "id" | "kind">): string | undefined {
    const envName = ENV_KEYS[p.kind];
    const fromEnv = envName && p.id === p.kind ? this.env[envName] : undefined;
    if (fromEnv) return fromEnv;
    const idEnv = this.env[`PAP_KEY_${p.id.toUpperCase().replace(/-/g, "_")}`];
    if (idEnv) return idEnv;
    if (this.stored.has(p.id)) return this.stored.get(p.id);
    let found: string | undefined;
    if (this.keychain) {
      try {
        found =
          this.exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", p.id, "-w"]).trim() ||
          undefined;
      } catch {}
    }
    found ??= this.readFile()[p.id] || undefined;
    this.stored.set(p.id, found);
    return found;
  }

  hasKey(p: Pick<ProviderConfig, "id" | "kind">): boolean {
    return !!this.getKey(p);
  }

  /** Keychain on macOS (falls back to the 0600 file if `security` fails). Returns where it went. */
  setKey(providerId: string, key: string): "keychain" | "file" {
    this.stored.delete(providerId);
    if (this.keychain) {
      try {
        this.exec("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", providerId, "-w", key]);
        const f = this.readFile();
        if (providerId in f) {
          delete f[providerId];
          this.writeFile(f);
        }
        return "keychain";
      } catch {}
    }
    this.writeFile({ ...this.readFile(), [providerId]: key });
    return "file";
  }

  deleteKey(providerId: string): void {
    this.stored.delete(providerId);
    if (this.keychain) {
      try {
        this.exec("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", providerId]);
      } catch {}
    }
    const f = this.readFile();
    if (providerId in f) {
      delete f[providerId];
      this.writeFile(f);
    }
  }
}
