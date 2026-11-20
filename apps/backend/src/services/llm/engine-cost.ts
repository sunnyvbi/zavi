
import { estimateCostUsd, type LLMUsage } from "@/services/anthropic";
import {
  estimateOpenAiCostUsd,
  estimateBedrockCostUsd,
  estimateFireworksCostUsd,
} from "@/services/openai";
import type { Provider } from "@/services/llm/models";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";

export function pricingVendorForModelId(model: string): Provider {
  const raw = (model ?? "").trim();
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  const bare = colon > 0 ? raw.slice(colon + 1) : raw;

  if (prefix === "anthropic") return "anthropic";
  if (prefix === "openai") return "openai";
  if (prefix === "fireworks") return "fireworks";
  if (prefix === "bedrock") return "bedrock";

  if (/^claude[-_]/i.test(bare)) return "anthropic";
  if (bare.startsWith("gpt-") || bare.startsWith("o1") || bare.startsWith("o3")) {
    return "openai";
  }
  if (bare.startsWith("accounts/fireworks/")) return "fireworks";
  if (bare.startsWith("qwen.") || bare.startsWith("zai.") || bare.startsWith("mistral.")) {
    return "bedrock";
  }
  return "anthropic";
}

export function bareModelId(model: string): string {
  const raw = (model ?? "").trim();
  const colon = raw.indexOf(":");
  return colon > 0 ? raw.slice(colon + 1) : raw;
}

export function estimateEngineCostUsd(
  provider: Provider,
  model: string,
  usage: NormalizedUsage,
): number {
  const billedInput = usage.input_tokens + usage.cache_read_input_tokens;
  if (provider === "bedrock") {
    return estimateBedrockCostUsd(model, {
      input_tokens: billedInput,
      output_tokens: usage.output_tokens,
    });
  }
  if (provider === "fireworks") {
    return estimateFireworksCostUsd(model, {
      input_tokens: billedInput,
      output_tokens: usage.output_tokens,
    });
  }
  if (provider === "langchain") {
    const vendor = pricingVendorForModelId(model);
    if (vendor !== "langchain") {
      return estimateEngineCostUsd(vendor, bareModelId(model), usage);
    }
  }
  if (provider === "openai" || provider === "codex") {
    return estimateOpenAiCostUsd(model, {
      input_tokens: billedInput,
      output_tokens: usage.output_tokens,
    });
  }
  return estimateCostUsd(model, usage as unknown as LLMUsage);
}
