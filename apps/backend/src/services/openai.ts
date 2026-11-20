
import OpenAI from "openai";

let _client: OpenAI | null = null;
let _resolved = false;

export function getOpenAi(): OpenAI | null {
  if (_resolved) return _client;
  _resolved = true;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    _client = null;
    return null;
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

export const OPENAI_CRITIC_MODEL =
  process.env.PRAXIS_CRITIC_OPENAI_MODEL || "gpt-5.5";

export type OpenAiUsage = {
  input_tokens: number;
  output_tokens: number;
};

export const OPENAI_PRICING: Record<
  string,
  { input: number; output: number }
> = {
  "gpt-5.5": { input: 5.0, output: 30.0 },
};

const OPENAI_FALLBACK_PRICE = Object.values(OPENAI_PRICING).reduce(
  (m, p) => ({ input: Math.max(m.input, p.input), output: Math.max(m.output, p.output) }),
  { input: 0, output: 0 },
);

export function estimateOpenAiCostUsd(
  model: string,
  usage: OpenAiUsage,
): number {
  const p = OPENAI_PRICING[model] ?? OPENAI_FALLBACK_PRICE;
  const inputCost = (usage.input_tokens / 1_000_000) * p.input;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export const BEDROCK_PRICING: Record<
  string,
  { input: number; output: number }
> = {
  "qwen.qwen3-next-80b-a3b-instruct": { input: 0.15, output: 1.2 },
  "mistral.mistral-large-3-675b-instruct": { input: 3.0, output: 9.0 },
  "deepseek.v3.2": { input: 0.3, output: 0.5 },
  "deepseek.v3.1": { input: 0.3, output: 0.5 },
  "zai.glm-5": { input: 0.6, output: 2.2 },
};

const BEDROCK_FALLBACK_PRICE = Object.values(BEDROCK_PRICING).reduce(
  (max, p) => (p.input + p.output > max.input + max.output ? p : max),
  { input: 0.15, output: 1.2 },
);

export function estimateBedrockCostUsd(
  model: string,
  usage: OpenAiUsage,
): number {
  const p = BEDROCK_PRICING[model] ?? BEDROCK_FALLBACK_PRICE;
  const inputCost = (usage.input_tokens / 1_000_000) * p.input;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export const FIREWORKS_PRICING: Record<
  string,
  { input: number; output: number }
> = {
  "accounts/fireworks/models/glm-5p2": { input: 1.4, output: 4.4 },
};

const FIREWORKS_FALLBACK_PRICE = Object.values(FIREWORKS_PRICING).reduce(
  (max, p) => (p.input + p.output > max.input + max.output ? p : max),
  { input: 1.4, output: 4.4 },
);

export function estimateFireworksCostUsd(
  model: string,
  usage: OpenAiUsage,
): number {
  const p = FIREWORKS_PRICING[model] ?? FIREWORKS_FALLBACK_PRICE;
  const inputCost = (usage.input_tokens / 1_000_000) * p.input;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}
