
import {
  getAnthropic,
  DEFAULT_MODEL,
  PRICING,
  estimateCostUsd,
  heliconePropertyHeaders,
  cachedSystemBlock,
} from "@/services/anthropic";
import { resolveRoleModel } from "@/services/llm/resolve-role-model";

export type SynthInput = {
  system_prompt: string;
  user_prompt: string;
  max_tokens?: number;
  model?: string;
  role?: string;
  tenant_id?: string | null;
};

export type SynthOutput = {
  markdown: string;
  cost_usd: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
};

const DEFAULT_MAX_TOKENS = 2048;

export async function synthMarkdown(input: SynthInput): Promise<SynthOutput> {
  const usedRoleOverride = !input.model && !!input.role;
  const model =
    input.model ??
    (input.role ? await resolveRoleModel(input.role, DEFAULT_MODEL, input.tenant_id) : DEFAULT_MODEL);

  if (!Object.prototype.hasOwnProperty.call(PRICING, model)) {
    throw new Error(
      `synthMarkdown: unknown model id: '${model}'. Must be one of: ${Object.keys(PRICING).join(", ")}`,
    );
  }

  try {
    return await runSynth(model, input);
  } catch (err) {
    if (usedRoleOverride && model !== DEFAULT_MODEL) {
      console.warn(
        `[synthMarkdown] override model '${model}' failed (${(err as Error).message}); retrying once on ${DEFAULT_MODEL}`,
      );
      return await runSynth(DEFAULT_MODEL, input);
    }
    throw err;
  }
}

async function runSynth(model: string, input: SynthInput): Promise<SynthOutput> {
  const resp = await getAnthropic().messages.create(
    {
      model,
      max_tokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
      system: [cachedSystemBlock(input.system_prompt)],
      messages: [{ role: "user", content: input.user_prompt }],
    },
    {
      headers: heliconePropertyHeaders({
        tenantId: input.tenant_id,
        agentSlug: input.role,
      }),
    },
  );

  const markdown = resp.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!markdown) {
    throw new Error(
      "synthMarkdown: empty response — no text blocks in Anthropic response",
    );
  }

  const usage = resp.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const input_tokens = usage.input_tokens;
  const output_tokens = usage.output_tokens;
  const cost_usd = estimateCostUsd(model, {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  });

  return { markdown, cost_usd, model, input_tokens, output_tokens };
}
