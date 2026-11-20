import type { DeepAgentProfileId, DeepAgentPromptProfile } from "./types";
import { CODEX_PROFILE } from "./codex";
import { CLAUDE_PROFILE } from "./claude";
import { FIREWORKS_KIMI_PROFILE } from "./fireworks-kimi";
import { FIREWORKS_GLM_PROFILE } from "./fireworks-glm";

const BY_ID: Record<DeepAgentProfileId, DeepAgentPromptProfile> = {
  codex: CODEX_PROFILE,
  claude: CLAUDE_PROFILE,
  "fireworks-kimi": FIREWORKS_KIMI_PROFILE,
  "fireworks-glm": FIREWORKS_GLM_PROFILE,
  default: CODEX_PROFILE,
};

export function getDeepAgentProfile(id: DeepAgentProfileId): DeepAgentPromptProfile {
  return BY_ID[id] ?? CODEX_PROFILE;
}

export function listDeepAgentProfileIds(): DeepAgentProfileId[] {
  return ["codex", "claude", "fireworks-kimi", "fireworks-glm", "default"];
}

export type { DeepAgentProfileId, DeepAgentPromptProfile, SubagentPromptDef } from "./types";
export {
  PROFILE_HEADER,
  MODEL_ADDENDUM_HEADER,
} from "./types";
