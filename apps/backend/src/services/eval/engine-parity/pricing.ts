
import type { NormalizedUsage } from "@/services/llm/normalize-usage";

const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "gpt-5.5": { input: 5.0, output: 25.0 },
};

const FALLBACK = { input: 5.0, output: 25.0 };

const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

export function estimateParityCostUsd(
  model: string,
  usage: NormalizedUsage,
): number {
  const r = RATES[model] ?? FALLBACK;
  const inputCost =
    (usage.input_tokens / 1_000_000) * r.input +
    (usage.cache_creation_input_tokens / 1_000_000) * r.input * CACHE_WRITE_MULT +
    (usage.cache_read_input_tokens / 1_000_000) * r.input * CACHE_READ_MULT;
  const outputCost = (usage.output_tokens / 1_000_000) * r.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}
