
import OpenAI from "openai";
import { MODELS, assertModelMatchesProvider } from "@/services/llm/models";
import {
  buildBedrockJudgeLadder,
  type ShadowJudgeFn,
} from "./engine-parity";

export function resolveBedrockJudgeModel(
  env: Record<string, string | undefined> = process.env,
): string {
  const [{ model }] = buildBedrockJudgeLadder({
    env,
    defaultModel: MODELS.bedrock.judgeDeepseekV32,
  });
  return model;
}

export function assertBedrockJudgeAvailable(
  env: Record<string, string | undefined> = process.env,
): { baseURL: string; apiKey: string; model: string } {
  const baseURL = env.BEDROCK_OPENAI_BASE_URL;
  const apiKey = env.AWS_BEARER_TOKEN_BEDROCK;
  if (!baseURL || !apiKey) {
    throw new Error(
      "in-VPC Bedrock judge unavailable: BEDROCK_OPENAI_BASE_URL and/or " +
        "AWS_BEARER_TOKEN_BEDROCK is not set. Add both to Secrets Manager " +
        "(praxis-envprod-1) and restart — there is NO 3rd-party judge fallback.",
    );
  }
  const model = resolveBedrockJudgeModel(env);
  assertModelMatchesProvider("bedrock", model);
  return { baseURL, apiKey, model };
}

export function makeBedrockJudgeFn(
  env: Record<string, string | undefined> = process.env,
): ShadowJudgeFn {
  const { baseURL, apiKey, model } = assertBedrockJudgeAvailable(env);
  const client = new OpenAI({ apiKey, baseURL });
  return async ({ system, user }) => {
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      });
      const text = resp.choices?.[0]?.message?.content ?? "";
      const out = typeof text === "string" ? text.trim() : "";
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };
}
