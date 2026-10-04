// The locally installed CLI agents the dictation agent can run through. Kept
// free of imports so routing helpers can load it under `node --test`.
export const CLI_AGENT_PROVIDER_IDS = ["claude-code", "codex"] as const;
export type CliAgentProviderId = (typeof CLI_AGENT_PROVIDER_IDS)[number];
export const DEFAULT_CLI_AGENT_PROVIDER: CliAgentProviderId = CLI_AGENT_PROVIDER_IDS[0];

export function isCliAgentProvider(provider?: string): provider is CliAgentProviderId {
  return CLI_AGENT_PROVIDER_IDS.includes(provider as CliAgentProviderId);
}

/** What a running CLI agent is doing, reported while it works. */
export interface CliAgentStage {
  kind: "command" | "tool" | "skill" | "thinking";
  name?: string;
}
