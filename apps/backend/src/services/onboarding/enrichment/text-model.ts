import { createMessageWithFailover, DEFAULT_FAST_MODEL, cachedSystemBlock } from "@/services/anthropic";

export type EnrichmentCompleteRequest = { system: string; user: string; maxTokens: number; timeoutMs: number };
export type EnrichmentComplete = (req: EnrichmentCompleteRequest) => Promise<string>;

export const apiComplete: EnrichmentComplete = async ({ system, user, maxTokens, timeoutMs }) => {
  const resp = await createMessageWithFailover(
    {
      model: DEFAULT_FAST_MODEL,
      max_tokens: maxTokens,
      system: [cachedSystemBlock(system)],
      messages: [{ role: "user", content: user }],
    },
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  return resp.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
};
