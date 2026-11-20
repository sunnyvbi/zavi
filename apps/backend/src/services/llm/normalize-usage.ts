
import type { Provider } from "@/services/llm/models";

export type NormalizedUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

export function normalizeUsage(raw: unknown, provider: Provider): NormalizedUsage {
  const zero: NormalizedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  if (raw === null || raw === undefined || typeof raw !== "object") return zero;
  const u = raw as Record<string, unknown>;

  if (provider === "openai" || provider === "codex") {
    const details = u.prompt_tokens_details;
    const cachedRead =
      details && typeof details === "object"
        ? num((details as Record<string, unknown>).cached_tokens)
        : 0;
    const prompt = num(u.prompt_tokens);
    return {
      input_tokens: Math.max(0, prompt - cachedRead),
      output_tokens: num(u.completion_tokens),
      cache_read_input_tokens: cachedRead,
      cache_creation_input_tokens: 0,
    };
  }

  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
  };
}
