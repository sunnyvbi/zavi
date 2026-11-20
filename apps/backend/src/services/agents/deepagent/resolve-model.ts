
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { isCodexEnabled } from "@/services/codex-subscription";
import { isAnthropicModel } from "@/services/llm/models";
import {
  bareOpenAiModelId,
  buildCodexChatModel,
  DEEPAGENT_CODEX_MODEL,
} from "./codex-langchain-model";
import { toLangChainModelId } from "./model-id";

export type DeepAgentModel = string | BaseLanguageModel;

function codexActive(): boolean {
  return isCodexEnabled() && process.env.DEEPAGENT_USE_CODEX !== "0";
}

export function resolveDeepAgentModel(langChainModelId: string): DeepAgentModel {
  const m = (langChainModelId ?? "").trim();
  if (!m) throw new Error("resolveDeepAgentModel: empty model id");
  if (!codexActive()) return m;

  const useCodex =
    m.startsWith("openai:") ||
    m.startsWith("fireworks:") ||
    m.startsWith("gpt-") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("accounts/fireworks/");

  if (!useCodex) return m;

  const bare =
    m.startsWith("openai:") || m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")
      ? bareOpenAiModelId(m.startsWith("openai:") ? m : `openai:${m}`)
      : DEEPAGENT_CODEX_MODEL;

  const llm = buildCodexChatModel(bare);
  if (!llm) return m;
  return llm;
}

export function deepAgentModelId(agentModel?: string): string {
  const pinned = process.env.DEEPAGENT_DEFAULT_MODEL?.trim();
  if (pinned) return pinned.includes(":") ? pinned : toLangChainModelId(pinned);

  const m = (agentModel ?? "").trim();
  if (codexActive() && (!m || isAnthropicModel(m))) {
    return `openai:${DEEPAGENT_CODEX_MODEL}`;
  }
  if (m) return toLangChainModelId(m);
  return fireworksDefaultModelId();
}

function fireworksDefaultModelId(): string {
  return (
    process.env.DEEPAGENT_FIREWORKS_MODEL?.trim() ||
    "fireworks:accounts/fireworks/models/kimi-k3"
  );
}

export function deepAgentFallbackModelId(): string | undefined {
  const raw = process.env.DEEPAGENT_FALLBACK_MODEL?.trim();
  if (!raw) return undefined;
  return raw.includes(":") ? raw : toLangChainModelId(raw);
}

export function deepAgentDefaultLangChainModelId(): string {
  return deepAgentModelId();
}
