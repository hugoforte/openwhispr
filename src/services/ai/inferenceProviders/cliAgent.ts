import type { InferenceProvider, ProviderCallParams } from "./types";
import logger from "../../../utils/logger";

import { DEFAULT_CLI_AGENT_PROVIDER, isCliAgentProvider } from "../../../config/cliAgentProviders";

export {
  CLI_AGENT_PROVIDER_IDS,
  DEFAULT_CLI_AGENT_PROVIDER,
  isCliAgentProvider,
} from "../../../config/cliAgentProviders";
export type { CliAgentProviderId } from "../../../config/cliAgentProviders";

type CliAgentConfig = ProviderCallParams["config"];

/**
 * Runs one prompt through the configured local CLI agent and returns its final
 * answer. Shared by the single-shot provider (selection edits) and the
 * assistant panel's stream, which is where standalone voice commands land.
 */
export async function runCliAgent({
  prompt,
  model,
  config,
}: {
  prompt: string;
  model: string;
  config: CliAgentConfig;
}): Promise<string> {
  if (typeof window === "undefined" || !window.electronAPI?.processCliAgent) {
    throw new Error("CLI agent is not available in this environment");
  }
  const cli = isCliAgentProvider(config.provider) ? config.provider : DEFAULT_CLI_AGENT_PROVIDER;
  logger.logReasoning("CLI_AGENT_START", { cli, model, textLength: prompt.length });
  const startTime = Date.now();

  const result = await window.electronAPI.processCliAgent({
    cli,
    prompt,
    model,
    permissionMode: config.cliPermissionMode || "auto",
    workingDir: config.cliWorkingDir || "",
    timeoutSeconds: config.cliTimeoutSeconds ?? 240,
    sessionMinutes: config.cliSessionMinutes ?? 30,
    systemPrompt: config.systemPrompt || "",
    extraPrompt: config.cliExtraPrompt || "",
  });

  if (!result.success) {
    logger.logReasoning("CLI_AGENT_ERROR", { cli, error: result.error, code: result.errorCode });
    throw new Error(result.error);
  }
  if (result.permissionDenials?.length) {
    window.dispatchEvent(
      new CustomEvent("cli-agent-denials", { detail: result.permissionDenials })
    );
  }
  logger.logReasoning("CLI_AGENT_SUCCESS", {
    cli,
    processingTimeMs: Date.now() - startTime,
    resultLength: result.text.length,
  });
  return result.text;
}

export const cliAgentProvider: InferenceProvider = {
  id: "cli-agent",
  call: ({ text, model, config }) => runCliAgent({ prompt: text, model, config }),
};
