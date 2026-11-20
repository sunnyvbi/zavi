
import type { Provider } from "@/services/llm/models";
import { MODELS, isAnthropicModel } from "@/services/llm/models";

export type DepthLevel = "light" | "deep";

export function resolveDepthModel(
  provider: Provider,
  level: DepthLevel,
  agentBaseModel: string,
  agentDeepModel?: string,
): string {
  switch (provider) {
    case "anthropic":
      return level === "deep" ? (agentDeepModel ?? MODELS.anthropic.opus) : agentBaseModel;

    case "openai":
    case "codex":
      return MODELS.openai.flagship;
    case "bedrock":
      return MODELS.bedrock.qwen3Next80b;
    case "fireworks":
      return MODELS.fireworks.glm52;

    case "langchain":
      return level === "deep" && isAnthropicModel(agentBaseModel)
        ? MODELS.anthropic.opus
        : agentBaseModel;
    case "openrouter":
      return agentBaseModel;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
