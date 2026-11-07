// Connects the crew (orchestrator, providers, ledger, settings) to the server. Until the crew package is present this
// returns nothing and the studio runs without agents.
import type { Registry, Workspace } from "@pap/tools";
import type { CrewApi, Hooks } from "./app.ts";

export async function wireCrew(_deps: {
  workspace: Workspace;
  registry: Registry;
}): Promise<{ crew?: CrewApi; hooks?: Hooks }> {
  return {};
}
