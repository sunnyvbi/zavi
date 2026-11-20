
export const OPUS_INPUT_PER_TOKEN = 0.000015;
export const OPUS_OUTPUT_PER_TOKEN = 0.000075;
export const TAVILY_PER_CALL = 0.01;
export const FETCH_PER_CALL = 0;
export const APIFY_PER_CALL = 0.05;

export const EXPECTED_OUTPUT_RESERVE_TOKENS = 4000;

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateCostUsd(args: {
  basePromptTokens: number;
  enrichmentTokens: number;
  tavilyCalls: number;
  fetchCalls: number;
  apifyCalls?: number;
}): number {
  const inputCost =
    (args.basePromptTokens + args.enrichmentTokens) * OPUS_INPUT_PER_TOKEN;
  const outputCost = EXPECTED_OUTPUT_RESERVE_TOKENS * OPUS_OUTPUT_PER_TOKEN;
  const tavilyCost = args.tavilyCalls * TAVILY_PER_CALL;
  const fetchCost = args.fetchCalls * FETCH_PER_CALL;
  const apifyCost = (args.apifyCalls ?? 0) * APIFY_PER_CALL;
  return inputCost + outputCost + tavilyCost + fetchCost + apifyCost;
}
