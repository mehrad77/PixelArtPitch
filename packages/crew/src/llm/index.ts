// The model layer, in one place.
import { AnthropicProvider } from "./anthropic.ts";
import type { HttpOpts } from "./http.ts";
import { OpenAICompatProvider } from "./openai.ts";
import type { SecretStore } from "./settings.ts";
import type { Provider, ProviderConfig } from "./types.ts";

export * from "./anthropic.ts";
export * from "./budget.ts";
export * from "./estimator.ts";
export * from "./fake.ts";
export * from "./http.ts";
export * from "./ledger.ts";
export * from "./openai.ts";
export * from "./paths.ts";
export * from "./prices.ts";
export * from "./probe.ts";
export * from "./roles.ts";
export * from "./schema.ts";
export * from "./settings.ts";
export * from "./structured.ts";
export * from "./types.ts";

/** A provider client for a config; keys are looked up per call from the secret store. */
export function createProvider(config: ProviderConfig, secrets: SecretStore, http: HttpOpts = {}): Provider {
  const getKey = () => secrets.getKey(config);
  return config.kind === "anthropic"
    ? new AnthropicProvider(config, { ...http, getKey })
    : new OpenAICompatProvider(config, { ...http, getKey });
}
