
import OpenAI from "openai";
import { MODELS } from "@/services/llm/models";
import { estimateOpenAiCostUsd } from "@/services/openai";
import { getAppSetting } from "@/services/settings";
import { APP_SETTINGS } from "@/services/settings/registry";

export interface CriticFamilyConfig {
  family: string;
  model: string;
  baseURL?: string;
  apiKeyEnv: string;
  costPerMTokIn: number;
  costPerMTokOut: number;
  tokenParam: "max_completion_tokens" | "max_tokens";
}

export const CRITIC_FAMILIES = {
  openai: {
    family: "openai" as const,
    get model(): string {
      return process.env.OPENAI_CRITIC_MODEL || MODELS.openai.flagship;
    },
    baseURL: undefined as string | undefined,
    apiKeyEnv: "OPENAI_API_KEY",
    costPerMTokIn: 5.0,
    costPerMTokOut: 30.0,
    tokenParam: "max_completion_tokens",
  },
  glm52: {
    family: "glm52" as const,
    model: MODELS.fireworks.glm52,
    get baseURL(): string {
      return process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1";
    },
    apiKeyEnv: "FIREWORKS_API_KEY",
    costPerMTokIn: 0.9,
    costPerMTokOut: 0.9,
    tokenParam: "max_tokens",
  },
} satisfies Record<string, CriticFamilyConfig>;

export type CriticFamilyKey = keyof typeof CRITIC_FAMILIES;

export async function resolveCriticFamily(): Promise<CriticFamilyKey> {
  const fromSetting = await getAppSetting("critic_family");
  const raw =
    fromSetting !== undefined ? String(fromSetting) : process.env.CRITIC_FAMILY;
  if (raw && Object.prototype.hasOwnProperty.call(CRITIC_FAMILIES, raw)) {
    return raw as CriticFamilyKey;
  }
  const regDefault = String(APP_SETTINGS.critic_family.defaultValue);
  if (Object.prototype.hasOwnProperty.call(CRITIC_FAMILIES, regDefault)) {
    return regDefault as CriticFamilyKey;
  }
  return "openai";
}

export interface CallCriticModelInput {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CallCriticModelResult {
  text: string;
  cost_usd: number;
  model: string;
  family: string;
}

export async function callCriticModel(
  opts: CallCriticModelInput,
): Promise<CallCriticModelResult> {
  const family = await resolveCriticFamily();
  const cfg = CRITIC_FAMILIES[family];

  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `callCriticModel: ${cfg.apiKeyEnv} unset but critic family '${family}' was selected — set the key or change CRITIC_FAMILY.`,
    );
  }

  const client = new OpenAI({
    apiKey,
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  });

  const resp = await client.chat.completions.create(
    {
      model: cfg.model,
      [cfg.tokenParam]: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]) : AbortSignal.timeout(opts.timeoutMs) },
  );

  const text = resp.choices[0]?.message?.content ?? "";
  const input_tokens = resp.usage?.prompt_tokens ?? 0;
  const output_tokens = resp.usage?.completion_tokens ?? 0;

  const cost_usd =
    family === "openai"
      ? estimateOpenAiCostUsd(cfg.model, { input_tokens, output_tokens })
      : (input_tokens / 1_000_000) * cfg.costPerMTokIn +
        (output_tokens / 1_000_000) * cfg.costPerMTokOut;

  return { text, cost_usd, model: cfg.model, family: cfg.family };
}
