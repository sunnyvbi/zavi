
import type { DeepAgentPromptProfile } from "./types";
import { CODEX_PROFILE } from "./codex";

const GLM_MODEL_ADDENDUM = [
  "FIREWORKS GLM PROFILE:",
  "- Follow labeled bet/digest blocks exactly when the parent agent contract requires them.",
  "- Ground every $ and % in a tool result from this run — hedge or omit when ungrounded.",
  "- Delegate wide creative or reconciliation pulls to subagents; keep the parent synthesis thin.",
].join("\n");

export const FIREWORKS_GLM_PROFILE: DeepAgentPromptProfile = {
  ...CODEX_PROFILE,
  id: "fireworks-glm",
  label: "Fireworks GLM-5.2",
  modelAddendum: GLM_MODEL_ADDENDUM,
};
