
import type { Provider } from "@/services/llm/models";
import type { AgentMetadata } from "../types";
import type { AgentEngine } from "./types";
import {
  OpenAIAgentEngine,
  BedrockOpenAICompatAgentEngine,
  FireworksOpenAICompatAgentEngine,
  CodexSubscriptionAgentEngine,
  OpenRouterOpenAICompatAgentEngine,
} from "./openai-engine";
import { AnthropicAgentEngine } from "./anthropic-engine";
import { LangChainDeepAgentEngine } from "../deepagent";

export function pickProvider(
  meta: Pick<AgentMetadata, "provider"> | { provider?: Provider },
): Provider {
  return meta.provider ?? "anthropic";
}

export function pickEngine(provider: Provider): AgentEngine {
  if (provider === "openai") return new OpenAIAgentEngine();
  if (provider === "anthropic") return new AnthropicAgentEngine();
  if (provider === "bedrock") return new BedrockOpenAICompatAgentEngine();
  if (provider === "fireworks") return new FireworksOpenAICompatAgentEngine();
  if (provider === "codex") return new CodexSubscriptionAgentEngine();
  if (provider === "openrouter") return new OpenRouterOpenAICompatAgentEngine();
  if (provider === "langchain") return new LangChainDeepAgentEngine();
  throw new Error(
    `pickEngine: provider '${provider}' has no engine adapter in this build. ` +
      `This is a routing bug — the dispatcher must take a known-provider branch.`,
  );
}
