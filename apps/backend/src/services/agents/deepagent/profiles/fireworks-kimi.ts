
import type { DeepAgentPromptProfile } from "./types";
import { CODEX_PROFILE } from "./codex";

const KIMI_MODEL_ADDENDUM = [
  "FIREWORKS KIMI PROFILE:",
  "- Keep parent replies scannable: lead with the decision, then evidence bullets.",
  "- Subagent file outputs are mandatory — return paths, not pasted JSON walls.",
  "- If a tool schema lists required fields, populate them on first call (avoid empty {}).",
].join("\n");

export const FIREWORKS_KIMI_PROFILE: DeepAgentPromptProfile = {
  ...CODEX_PROFILE,
  id: "fireworks-kimi",
  label: "Fireworks Kimi K3",
  modelAddendum: KIMI_MODEL_ADDENDUM,
};
