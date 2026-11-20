
import { isCodexEnabled } from "@/services/codex-subscription";
import type { DeepAgentModel } from "./resolve-model";
import type { DeepAgentProfileId } from "./profiles/types";
import { getDeepAgentProfile, listDeepAgentProfileIds } from "./profiles";

const VALID_IDS = new Set<string>(listDeepAgentProfileIds());

function parseEnvOverride(): DeepAgentProfileId | null {
  const raw = process.env.DEEPAGENT_PROMPT_PROFILE?.trim().toLowerCase();
  if (!raw || !VALID_IDS.has(raw)) return null;
  return raw as DeepAgentProfileId;
}

export function profileIdFromLangChainModelId(langChainModelId: string): DeepAgentProfileId {
  const m = (langChainModelId ?? "").trim().toLowerCase();
  if (!m) return "default";

  if (m.startsWith("anthropic:") || m.startsWith("claude-")) return "claude";
  if (m.includes("glm")) return "fireworks-glm";
  if (m.startsWith("fireworks:") || m.includes("kimi")) return "fireworks-kimi";
  if (
    m.startsWith("openai:") ||
    m.startsWith("gpt-") ||
    m.startsWith("o1") ||
    m.startsWith("o3")
  ) {
    return "codex";
  }

  return "default";
}

export function resolveDeepAgentProfileId(model: DeepAgentModel): DeepAgentProfileId {
  const forced = parseEnvOverride();
  if (forced) return forced;

  if (typeof model !== "string") {
    if (isCodexEnabled() && model.constructor?.name === "ChatOpenAI") return "codex";
    return "default";
  }

  return profileIdFromLangChainModelId(model);
}

export function resolveDeepAgentProfile(model: DeepAgentModel) {
  const id = resolveDeepAgentProfileId(model);
  return getDeepAgentProfile(id);
}
